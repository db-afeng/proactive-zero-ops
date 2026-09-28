"""Deterministic Databricks SQL discovery and revision comparison.

The guard treats pull-request SQL as data.  This module therefore only parses
text; it never imports, executes, or renders code from the revision being
assessed.  SQLGlot's Databricks dialect provides the syntax tree, while the
small preprocessor below handles Lakeflow expectation clauses that SQLGlot
does not currently parse.  Preprocessing is deliberately narrow: syntax that
is not understood is returned as a :class:`ParseIssue`, never silently ignored.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Literal, TypeAlias

import sqlglot
from sqlglot import exp
from sqlglot.errors import ErrorLevel, ParseError

DIALECT = "databricks"

IssueSeverity: TypeAlias = Literal["warning", "error"]
DiscoveryCertainty: TypeAlias = Literal["complete", "partial", "failed"]
StatementChangeKind: TypeAlias = Literal[
    "added", "deleted", "renamed", "modified", "unchanged"
]
DocumentChangeKind: TypeAlias = Literal[
    "added", "deleted", "renamed", "renamed_modified", "modified", "unchanged"
]
ColumnChangeKind: TypeAlias = Literal["added", "deleted", "renamed", "modified"]


@dataclass(frozen=True)
class ParseIssue:
    """A visible limitation in deterministic SQL discovery."""

    code: str
    message: str
    severity: IssueSeverity = "error"
    line: int | None = None
    column: int | None = None
    evidence: str | None = None


@dataclass(frozen=True)
class Expectation:
    name: str
    expression_sql: str
    expression_ast: str
    action: str | None
    evidence_sql: str


@dataclass(frozen=True)
class InputSource:
    """A dependency declared by the proposed SQL, not observed runtime lineage."""

    kind: Literal["table", "stream", "read_files", "values"]
    name: str
    evidence_sql: str

    @property
    def key(self) -> tuple[str, str]:
        return self.kind, self.name


@dataclass(frozen=True)
class OutputColumn:
    ordinal: int
    name: str
    expression_sql: str
    expression_ast: str
    source_columns: tuple[str, ...]
    wildcard: bool = False


@dataclass(frozen=True)
class Join:
    join_type: str
    relation: str
    condition_sql: str | None
    evidence_sql: str


@dataclass(frozen=True)
class Filter:
    clause: Literal["where", "having", "qualify"]
    expression_sql: str
    expression_ast: str


@dataclass(frozen=True)
class ExplicitCast:
    output_column: str | None
    source_expression_sql: str
    target_type_sql: str
    expression_sql: str
    safe: bool


@dataclass(frozen=True)
class SqlStatementAnalysis:
    ordinal: int
    statement_kind: str
    output_dataset: str | None
    inputs: tuple[InputSource, ...]
    output_columns: tuple[OutputColumn, ...]
    joins: tuple[Join, ...]
    filters: tuple[Filter, ...]
    explicit_casts: tuple[ExplicitCast, ...]
    expectations: tuple[Expectation, ...]
    normalized_sql: str
    normalized_ast: str
    semantic_fingerprint: str
    definition_fingerprint: str
    evidence_sql: str

    @property
    def input_tables(self) -> tuple[str, ...]:
        return tuple(source.name for source in self.inputs if source.kind in {"table", "stream"})


@dataclass(frozen=True)
class SqlDocumentAnalysis:
    path: str
    source_hash: str
    statements: tuple[SqlStatementAnalysis, ...]
    issues: tuple[ParseIssue, ...]
    certainty: DiscoveryCertainty

    @property
    def complete(self) -> bool:
        return self.certainty == "complete"

    @property
    def output_datasets(self) -> tuple[str, ...]:
        return tuple(
            statement.output_dataset
            for statement in self.statements
            if statement.output_dataset is not None
        )


@dataclass(frozen=True)
class OutputColumnChange:
    kind: ColumnChangeKind
    base_name: str | None
    proposed_name: str | None
    base: OutputColumn | None
    proposed: OutputColumn | None


@dataclass(frozen=True)
class SqlStatementChange:
    kind: StatementChangeKind
    base: SqlStatementAnalysis | None
    proposed: SqlStatementAnalysis | None
    column_changes: tuple[OutputColumnChange, ...]
    added_inputs: tuple[InputSource, ...]
    removed_inputs: tuple[InputSource, ...]
    joins_changed: bool
    filters_changed: bool
    casts_changed: bool
    expectations_changed: bool
    semantic_changed: bool
    definition_changed: bool


@dataclass(frozen=True)
class SqlDocumentChange:
    kind: DocumentChangeKind
    base: SqlDocumentAnalysis | None
    proposed: SqlDocumentAnalysis | None
    statement_changes: tuple[SqlStatementChange, ...]
    semantic_changed: bool
    definition_changed: bool
    formatting_only: bool

    @property
    def complete(self) -> bool:
        return bool(
            (self.base is None or self.base.complete)
            and (self.proposed is None or self.proposed.complete)
        )


_VARIABLE = re.compile(r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_.-]*)\}")
_LAKEFLOW_CREATE = re.compile(
    r"\bCREATE\s+(?:OR\s+REFRESH\s+)?"
    r"(?P<kind>MATERIALIZED\s+VIEW|STREAMING\s+TABLE)\s+"
    r"(?P<target>[^\s(]+)",
    re.IGNORECASE,
)
_EXPECTATION_START = re.compile(
    r"^\s*CONSTRAINT\s+(?P<name>`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*)"
    r"\s+EXPECT\s*\(",
    re.IGNORECASE | re.DOTALL,
)
_EXPECTATION_ACTION = re.compile(
    r"^\s*ON\s+VIOLATION\s+(?P<action>DROP\s+ROW|FAIL\s+UPDATE)\s*$",
    re.IGNORECASE | re.DOTALL,
)


def parse_sql_document(
    sql: str,
    *,
    path: str = "<memory>",
    variables: Mapping[str, str] | None = None,
) -> SqlDocumentAnalysis:
    """Parse one SQL source file without executing any revision-controlled code.

    ``variables`` should be the already-selected bundle target's trusted
    catalog/schema values. Unknown substitutions are replaced with a stable
    placeholder solely to recover partial evidence, and always emit an error.
    """

    resolved_sql, variable_issues = _resolve_variables(sql, variables or {})
    issues: list[ParseIssue] = list(variable_issues)
    statements: list[SqlStatementAnalysis] = []
    pieces = _split_statements(resolved_sql)

    if not pieces:
        issues.append(
            ParseIssue(
                code="empty_sql",
                message="SQL document contains no statements",
                evidence=sql[:200] or None,
            )
        )

    for ordinal, (statement_sql, start_line) in enumerate(pieces):
        preprocessed, expectations, preprocess_issues = _preprocess_lakeflow(statement_sql)
        issues.extend(_offset_issues(preprocess_issues, start_line - 1))
        try:
            tree = sqlglot.parse_one(
                preprocessed,
                read=DIALECT,
                error_level=ErrorLevel.RAISE,
            )
        except ParseError as exc:
            issues.append(_parse_error_issue(exc, statement_sql, start_line))
            continue

        if tree is None:
            issues.append(
                ParseIssue(
                    code="empty_statement",
                    message="SQL parser produced no syntax tree for a non-empty statement",
                    line=start_line,
                    evidence=statement_sql[:300],
                )
            )
            continue
        if isinstance(tree, exp.Command):
            issues.append(
                ParseIssue(
                    code="unsupported_statement",
                    message=f"Unsupported Databricks SQL statement: {tree.name or tree.key}",
                    line=start_line,
                    evidence=statement_sql[:500],
                )
            )
            continue

        analysis, analysis_issues = _analyze_statement(
            tree,
            ordinal=ordinal,
            evidence_sql=statement_sql,
            expectations=expectations,
        )
        issues.extend(_offset_issues(analysis_issues, start_line - 1))
        if analysis is not None:
            statements.append(analysis)

    if (
        pieces
        and not statements
        and not any(issue.code == "unsupported_statement" for issue in issues)
    ):
        issues.append(
            ParseIssue(
                code="no_analyzable_statement",
                message="No SQL statement could be analyzed; discovery is incomplete",
                evidence=sql[:300],
            )
        )

    if not statements:
        certainty: DiscoveryCertainty = "failed"
    elif issues:
        certainty = "partial"
    else:
        certainty = "complete"
    return SqlDocumentAnalysis(
        path=path,
        source_hash=hashlib.sha256(sql.encode()).hexdigest(),
        statements=tuple(statements),
        issues=tuple(issues),
        certainty=certainty,
    )


def compare_sql_documents(
    base: SqlDocumentAnalysis | None,
    proposed: SqlDocumentAnalysis | None,
) -> SqlDocumentChange:
    """Compare parsed revisions structurally, ignoring formatting and SQL comments."""

    if base is None and proposed is None:
        raise ValueError("at least one SQL document revision is required")

    pairs = _pair_statements(base, proposed)
    changes = tuple(_compare_statement(old, new) for old, new in pairs)
    semantic_changed = any(change.semantic_changed for change in changes)
    definition_changed = any(change.definition_changed for change in changes)

    if base is None:
        kind: DocumentChangeKind = "added"
    elif proposed is None:
        kind = "deleted"
    else:
        path_changed = base.path != proposed.path
        if path_changed and definition_changed:
            kind = "renamed_modified"
        elif path_changed:
            kind = "renamed"
        elif definition_changed:
            kind = "modified"
        else:
            kind = "unchanged"

    formatting_only = bool(
        base is not None
        and proposed is not None
        and base.path == proposed.path
        and not definition_changed
        and base.source_hash != proposed.source_hash
    )
    return SqlDocumentChange(
        kind=kind,
        base=base,
        proposed=proposed,
        statement_changes=changes,
        semantic_changed=semantic_changed,
        definition_changed=definition_changed,
        formatting_only=formatting_only,
    )


def analyze_sql_change(
    *,
    base_sql: str | None,
    proposed_sql: str | None,
    base_path: str,
    proposed_path: str | None = None,
    base_variables: Mapping[str, str] | None = None,
    proposed_variables: Mapping[str, str] | None = None,
) -> SqlDocumentChange:
    """Convenience API for additions, deletions, modifications, and file renames."""

    head_path = proposed_path or base_path
    base = (
        parse_sql_document(base_sql, path=base_path, variables=base_variables)
        if base_sql is not None
        else None
    )
    proposed = (
        parse_sql_document(proposed_sql, path=head_path, variables=proposed_variables)
        if proposed_sql is not None
        else None
    )
    return compare_sql_documents(base, proposed)


def _resolve_variables(
    sql: str, variables: Mapping[str, str]
) -> tuple[str, tuple[ParseIssue, ...]]:
    issues: list[ParseIssue] = []

    def replace(match: re.Match[str]) -> str:
        name = match.group("name")
        candidates = (name, name.removeprefix("var."))
        value = next((variables[key] for key in candidates if key in variables), None)
        if value is not None:
            return str(value)
        line, column = _line_column(sql, match.start())
        issues.append(
            ParseIssue(
                code="unresolved_variable",
                message=(
                    f"Bundle variable {match.group(0)} was not resolved for the selected target"
                ),
                line=line,
                column=column,
                evidence=match.group(0),
            )
        )
        return f"__unresolved_{re.sub(r'[^A-Za-z0-9_]', '_', name)}__"

    return _VARIABLE.sub(replace, sql), tuple(issues)


def _split_statements(sql: str) -> list[tuple[str, int]]:
    pieces: list[tuple[str, int]] = []
    start = 0
    start_line = 1
    line = 1
    quote: str | None = None
    line_comment = False
    block_comment = False
    i = 0
    while i < len(sql):
        char = sql[i]
        following = sql[i + 1] if i + 1 < len(sql) else ""
        if char == "\n":
            line += 1
            line_comment = False
            i += 1
            continue
        if line_comment:
            i += 1
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                i += 2
            else:
                i += 1
            continue
        if quote:
            if char == quote:
                if following == quote and quote in {"'", '"', "`"}:
                    i += 2
                    continue
                quote = None
            elif char == "\\" and quote in {"'", '"'}:
                i += 2
                continue
            i += 1
            continue
        if char == "-" and following == "-":
            line_comment = True
            i += 2
            continue
        if char == "/" and following == "*":
            block_comment = True
            i += 2
            continue
        if char in {"'", '"', "`"}:
            quote = char
            i += 1
            continue
        if char == ";":
            piece = sql[start:i].strip()
            if piece and not _comments_only(piece):
                leading = sql[start:i].find(piece)
                piece_line = start_line + sql[start : start + max(leading, 0)].count("\n")
                pieces.append((piece, piece_line))
            start = i + 1
            start_line = line
        i += 1
    piece = sql[start:].strip()
    if piece and not _comments_only(piece):
        leading = sql[start:].find(piece)
        piece_line = start_line + sql[start : start + max(leading, 0)].count("\n")
        pieces.append((piece, piece_line))
    return pieces


def _comments_only(sql: str) -> bool:
    without_block = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    without_line = re.sub(r"--[^\n]*(?:\n|$)", "", without_block)
    return not without_line.strip()


def _preprocess_lakeflow(
    sql: str,
) -> tuple[str, tuple[Expectation, ...], tuple[ParseIssue, ...]]:
    create = _LAKEFLOW_CREATE.search(sql)
    if create is None:
        return sql, (), ()
    cursor = create.end()
    while cursor < len(sql) and sql[cursor].isspace():
        cursor += 1
    if cursor >= len(sql) or sql[cursor] != "(":
        return sql, (), ()
    close = _matching_parenthesis(sql, cursor)
    if close is None:
        line, column = _line_column(sql, cursor)
        issue = ParseIssue(
            code="unsupported_lakeflow_syntax",
            message="Unterminated Lakeflow table constraint block",
            line=line,
            column=column,
            evidence=sql[cursor : cursor + 300],
        )
        return sql, (), (issue,)
    body = sql[cursor + 1 : close]
    if not re.search(r"\bEXPECT\s*\(", body, flags=re.IGNORECASE):
        return sql, (), ()

    expectations: list[Expectation] = []
    issues: list[ParseIssue] = []
    for constraint in _split_top_level(body, ","):
        expectation, constraint_issues = _parse_expectation(constraint)
        if expectation is not None:
            expectations.append(expectation)
        issues.extend(constraint_issues)

    # Whitespace replacement keeps subsequent parser line numbers aligned to
    # the original evidence while removing only the unsupported clause.
    blanked = "".join("\n" if char == "\n" else " " for char in sql[cursor : close + 1])
    return sql[:cursor] + blanked + sql[close + 1 :], tuple(expectations), tuple(issues)


def _parse_expectation(
    constraint: str,
) -> tuple[Expectation | None, tuple[ParseIssue, ...]]:
    start = _EXPECTATION_START.match(constraint)
    if start is None:
        return None, (
            ParseIssue(
                code="unsupported_lakeflow_expectation",
                message="Unsupported item in Lakeflow expectation block",
                evidence=constraint.strip()[:300],
            ),
        )
    expression_open = start.end() - 1
    expression_close = _matching_parenthesis(constraint, expression_open)
    if expression_close is None:
        return None, (
            ParseIssue(
                code="unsupported_lakeflow_expectation",
                message="Unterminated EXPECT expression",
                evidence=constraint.strip()[:300],
            ),
        )
    expression_source = constraint[expression_open + 1 : expression_close]
    tail = constraint[expression_close + 1 :]
    action: str | None = None
    if tail.strip():
        action_match = _EXPECTATION_ACTION.match(tail)
        if action_match is None:
            return None, (
                ParseIssue(
                    code="unsupported_lakeflow_expectation",
                    message="Unsupported EXPECT violation action",
                    evidence=constraint.strip()[:300],
                ),
            )
        action = " ".join(action_match.group("action").upper().split())
    try:
        expression = sqlglot.parse_one(
            expression_source,
            read=DIALECT,
            error_level=ErrorLevel.RAISE,
        )
    except ParseError as exc:
        return None, (
            ParseIssue(
                code="unsupported_lakeflow_expectation",
                message=f"EXPECT expression could not be parsed: {exc}",
                evidence=constraint.strip()[:300],
            ),
        )
    if expression is None:
        return None, (
            ParseIssue(
                code="unsupported_lakeflow_expectation",
                message="EXPECT expression is empty",
                evidence=constraint.strip()[:300],
            ),
        )
    name = start.group("name").strip("`").replace("``", "`").lower()
    return (
        Expectation(
            name=name,
            expression_sql=_canonical_sql(expression),
            expression_ast=_normalized_ast(expression),
            action=action,
            evidence_sql=constraint.strip(),
        ),
        (),
    )


def _analyze_statement(
    tree: exp.Expression,
    *,
    ordinal: int,
    evidence_sql: str,
    expectations: tuple[Expectation, ...],
) -> tuple[SqlStatementAnalysis | None, tuple[ParseIssue, ...]]:
    output: exp.Table | None = None
    query: exp.Expression = tree
    statement_kind = tree.key.lower()

    if isinstance(tree, exp.Create):
        output = _as_table(tree.this)
        query = tree.expression or tree
        statement_kind = _create_kind(tree)
    elif isinstance(tree, exp.Insert):
        output = _as_table(tree.this)
        query = tree.expression or tree
        statement_kind = "insert"
    elif isinstance(tree, exp.Merge):
        output = _as_table(tree.this)
        query = tree
        statement_kind = "merge"
    elif isinstance(tree, exp.Query):
        statement_kind = "query"
    else:
        return None, (
            ParseIssue(
                code="unsupported_statement",
                message=f"Unsupported Databricks SQL AST node: {type(tree).__name__}",
                evidence=evidence_sql[:500],
            ),
        )

    output_dataset = _table_name(output) if output is not None else None
    inputs = _extract_inputs(query, output_dataset)
    output_columns, column_issues = _extract_output_columns(query)
    joins = _extract_joins(query)
    filters = _extract_filters(query)
    casts = _extract_casts(query)

    normalized_sql = _canonical_sql(tree)
    normalized_ast = _normalized_ast(tree)
    semantic_payload = {
        "statement_kind": statement_kind,
        "query_ast": _normalized_ast(query),
        "expectations": [
            asdict(expectation) | {"evidence_sql": ""} for expectation in expectations
        ],
        "properties": _semantic_properties(tree),
    }
    definition_payload = {
        "statement_ast": normalized_ast,
        "expectations": [
            asdict(expectation) | {"evidence_sql": ""} for expectation in expectations
        ],
    }
    return (
        SqlStatementAnalysis(
            ordinal=ordinal,
            statement_kind=statement_kind,
            output_dataset=output_dataset,
            inputs=inputs,
            output_columns=output_columns,
            joins=joins,
            filters=filters,
            explicit_casts=casts,
            expectations=expectations,
            normalized_sql=normalized_sql,
            normalized_ast=normalized_ast,
            semantic_fingerprint=_fingerprint(semantic_payload),
            definition_fingerprint=_fingerprint(definition_payload),
            evidence_sql=evidence_sql,
        ),
        column_issues,
    )


def _create_kind(create: exp.Create) -> str:
    properties = create.args.get("properties")
    expressions = properties.expressions if isinstance(properties, exp.Properties) else []
    if any(isinstance(item, exp.StreamingTableProperty) for item in expressions):
        return "streaming_table"
    if any(isinstance(item, exp.MaterializedProperty) for item in expressions):
        return "materialized_view"
    return f"create_{str(create.args.get('kind') or 'object').lower()}"


def _semantic_properties(tree: exp.Expression) -> list[str]:
    if not isinstance(tree, exp.Create):
        return []
    properties = tree.args.get("properties")
    if not isinstance(properties, exp.Properties):
        return []
    result = []
    for item in properties.expressions:
        # Descriptive comments do not change produced data. Other properties,
        # including CLUSTER BY, remain visible in the semantic definition.
        if "comment" in type(item).__name__.lower():
            continue
        result.append(_canonical_sql(item))
    return sorted(result)


def _extract_inputs(query: exp.Expression, output_dataset: str | None) -> tuple[InputSource, ...]:
    cte_names = {
        cte.alias_or_name.lower()
        for cte in query.find_all(exp.CTE)
        if cte.alias_or_name
    }
    sources: list[InputSource] = []
    for table in query.find_all(exp.Table):
        if isinstance(table.this, exp.Anonymous) and table.this.name.lower() == "read_files":
            function = table.this
            first = function.expressions[0] if function.expressions else None
            name = (
                first.this
                if isinstance(first, exp.Literal) and first.is_string
                else _canonical_sql(function)
            )
            sources.append(
                InputSource(
                    kind="read_files",
                    name=str(name),
                    evidence_sql=_canonical_sql(function),
                )
            )
            continue
        name = _table_name(table)
        if not name or name == output_dataset:
            continue
        if "." not in name and name.lower() in cte_names:
            continue
        kind: Literal["table", "stream"] = "stream" if _has_stream_ancestor(table) else "table"
        sources.append(InputSource(kind=kind, name=name, evidence_sql=_canonical_sql(table)))
    for values in query.find_all(exp.Values):
        sources.append(
            InputSource(kind="values", name="inline_values", evidence_sql=_canonical_sql(values))
        )
    deduplicated: dict[tuple[str, str], InputSource] = {}
    for source in sources:
        deduplicated.setdefault(source.key, source)
    return tuple(deduplicated[key] for key in sorted(deduplicated))


def _has_stream_ancestor(expression: exp.Expression) -> bool:
    parent = expression.parent
    while parent is not None:
        if isinstance(parent, exp.Stream):
            return True
        if isinstance(parent, (exp.Select, exp.CTE)):
            # STREAM is immediately outside its relation; once the containing
            # SELECT is reached, a farther STREAM cannot apply to this table.
            return False
        parent = parent.parent
    return False


def _extract_output_columns(
    query: exp.Expression,
) -> tuple[tuple[OutputColumn, ...], tuple[ParseIssue, ...]]:
    selects = list(query.selects) if isinstance(query, exp.Query) else []
    columns: list[OutputColumn] = []
    issues: list[ParseIssue] = []
    for ordinal, projection in enumerate(selects):
        expression = projection.this if isinstance(projection, exp.Alias) else projection
        wildcard = isinstance(expression, exp.Star) or any(expression.find_all(exp.Star))
        name = projection.alias_or_name or ("*" if wildcard else f"<unnamed:{ordinal + 1}>")
        if wildcard:
            issues.append(
                ParseIssue(
                    code="wildcard_output",
                    message=(
                        f"Output column {name!r} uses a wildcard and cannot be enumerated "
                        "without executing or querying the input schema"
                    ),
                    severity="warning",
                    evidence=_canonical_sql(projection),
                )
            )
        if name.startswith("<unnamed:"):
            issues.append(
                ParseIssue(
                    code="unnamed_output_column",
                    message="Output expression has no deterministic column name",
                    severity="warning",
                    evidence=_canonical_sql(projection),
                )
            )
        source_columns = tuple(
            sorted({_canonical_sql(column) for column in expression.find_all(exp.Column)})
        )
        columns.append(
            OutputColumn(
                ordinal=ordinal,
                name=name.lower(),
                expression_sql=_canonical_sql(expression),
                expression_ast=_normalized_ast(expression),
                source_columns=source_columns,
                wildcard=wildcard,
            )
        )
    return tuple(columns), tuple(issues)


def _extract_joins(query: exp.Expression) -> tuple[Join, ...]:
    joins: list[Join] = []
    for join in query.find_all(exp.Join):
        relation = _relation_name(join.this)
        side = str(join.args.get("side") or "").strip()
        kind = str(join.args.get("kind") or "").strip()
        join_type = " ".join(part for part in (side, kind) if part).lower() or "inner"
        condition = join.args.get("on")
        if condition is not None:
            condition_sql = _canonical_sql(condition)
        else:
            using = join.args.get("using") or []
            condition_sql = (
                f"USING ({', '.join(_canonical_sql(item) for item in using)})" if using else None
            )
        joins.append(
            Join(
                join_type=join_type,
                relation=relation,
                condition_sql=condition_sql,
                evidence_sql=_canonical_sql(join),
            )
        )
    return tuple(joins)


def _extract_filters(query: exp.Expression) -> tuple[Filter, ...]:
    filters: list[Filter] = []
    types: tuple[tuple[type[exp.Expression], Literal["where", "having", "qualify"]], ...] = (
        (exp.Where, "where"),
        (exp.Having, "having"),
        (exp.Qualify, "qualify"),
    )
    for node_type, clause in types:
        for node in query.find_all(node_type):
            condition = node.this
            filters.append(
                Filter(
                    clause=clause,
                    expression_sql=_canonical_sql(condition),
                    expression_ast=_normalized_ast(condition),
                )
            )
    return tuple(filters)


def _extract_casts(query: exp.Expression) -> tuple[ExplicitCast, ...]:
    casts: list[ExplicitCast] = []
    seen: set[int] = set()
    for select in query.find_all(exp.Select):
        for projection in select.expressions:
            output_name = projection.alias_or_name or None
            expression = projection.this if isinstance(projection, exp.Alias) else projection
            for cast in _casts_in(expression):
                seen.add(id(cast))
                casts.append(_cast_evidence(cast, output_name.lower() if output_name else None))
    for cast in _casts_in(query):
        if id(cast) not in seen:
            casts.append(_cast_evidence(cast, None))
    return tuple(casts)


def _casts_in(expression: exp.Expression):
    for node in expression.walk():
        if isinstance(node, (exp.Cast, exp.TryCast)):
            yield node


def _cast_evidence(cast: exp.Cast | exp.TryCast, output_name: str | None) -> ExplicitCast:
    return ExplicitCast(
        output_column=output_name,
        source_expression_sql=_canonical_sql(cast.this),
        target_type_sql=_canonical_sql(cast.args["to"]),
        expression_sql=_canonical_sql(cast),
        safe=isinstance(cast, exp.TryCast),
    )


def _pair_statements(
    base: SqlDocumentAnalysis | None,
    proposed: SqlDocumentAnalysis | None,
) -> list[tuple[SqlStatementAnalysis | None, SqlStatementAnalysis | None]]:
    old = list(base.statements if base else ())
    new = list(proposed.statements if proposed else ())
    pairs: list[tuple[SqlStatementAnalysis | None, SqlStatementAnalysis | None]] = []

    new_by_output: dict[str, list[SqlStatementAnalysis]] = defaultdict(list)
    for statement in new:
        if statement.output_dataset:
            new_by_output[statement.output_dataset].append(statement)
    paired_old: set[int] = set()
    paired_new: set[int] = set()
    for old_statement in old:
        if not old_statement.output_dataset:
            continue
        candidates = new_by_output.get(old_statement.output_dataset, [])
        candidate = next((item for item in candidates if id(item) not in paired_new), None)
        if candidate is not None:
            pairs.append((old_statement, candidate))
            paired_old.add(id(old_statement))
            paired_new.add(id(candidate))

    remaining_old = [item for item in old if id(item) not in paired_old]
    remaining_new = [item for item in new if id(item) not in paired_new]
    # A one-for-one unmatched statement in the same document is a deterministic
    # dataset rename candidate. For multi-statement files, ordinal pairing is
    # used only when cardinality is equal; otherwise additions/deletions remain
    # explicit rather than guessed.
    if len(remaining_old) == len(remaining_new):
        for old_statement, new_statement in zip(remaining_old, remaining_new, strict=True):
            pairs.append((old_statement, new_statement))
    else:
        pairs.extend((item, None) for item in remaining_old)
        pairs.extend((None, item) for item in remaining_new)
    return sorted(
        pairs,
        key=lambda pair: (
            pair[0].ordinal if pair[0] is not None else pair[1].ordinal if pair[1] else -1,
            0 if pair[0] is not None else 1,
        ),
    )


def _compare_statement(
    base: SqlStatementAnalysis | None,
    proposed: SqlStatementAnalysis | None,
) -> SqlStatementChange:
    if base is None:
        return SqlStatementChange(
            kind="added",
            base=None,
            proposed=proposed,
            column_changes=tuple(
                OutputColumnChange("added", None, column.name, None, column)
                for column in (proposed.output_columns if proposed else ())
            ),
            added_inputs=proposed.inputs if proposed else (),
            removed_inputs=(),
            joins_changed=bool(proposed and proposed.joins),
            filters_changed=bool(proposed and proposed.filters),
            casts_changed=bool(proposed and proposed.explicit_casts),
            expectations_changed=bool(proposed and proposed.expectations),
            semantic_changed=True,
            definition_changed=True,
        )
    if proposed is None:
        return SqlStatementChange(
            kind="deleted",
            base=base,
            proposed=None,
            column_changes=tuple(
                OutputColumnChange("deleted", column.name, None, column, None)
                for column in base.output_columns
            ),
            added_inputs=(),
            removed_inputs=base.inputs,
            joins_changed=bool(base.joins),
            filters_changed=bool(base.filters),
            casts_changed=bool(base.explicit_casts),
            expectations_changed=bool(base.expectations),
            semantic_changed=True,
            definition_changed=True,
        )

    output_renamed = base.output_dataset != proposed.output_dataset
    data_changed = base.semantic_fingerprint != proposed.semantic_fingerprint
    semantic_changed = output_renamed or data_changed
    definition_changed = base.definition_fingerprint != proposed.definition_fingerprint
    if output_renamed:
        kind: StatementChangeKind = "renamed" if not data_changed else "modified"
    elif definition_changed:
        kind = "modified"
    else:
        kind = "unchanged"
    base_inputs = {source.key: source for source in base.inputs}
    proposed_inputs = {source.key: source for source in proposed.inputs}
    return SqlStatementChange(
        kind=kind,
        base=base,
        proposed=proposed,
        column_changes=_compare_columns(base.output_columns, proposed.output_columns),
        added_inputs=tuple(
            proposed_inputs[key] for key in sorted(proposed_inputs.keys() - base_inputs.keys())
        ),
        removed_inputs=tuple(
            base_inputs[key] for key in sorted(base_inputs.keys() - proposed_inputs.keys())
        ),
        joins_changed=base.joins != proposed.joins,
        filters_changed=base.filters != proposed.filters,
        casts_changed=base.explicit_casts != proposed.explicit_casts,
        expectations_changed=(
            tuple(_expectation_key(item) for item in base.expectations)
            != tuple(_expectation_key(item) for item in proposed.expectations)
        ),
        semantic_changed=semantic_changed,
        definition_changed=definition_changed,
    )


def _compare_columns(
    base: tuple[OutputColumn, ...],
    proposed: tuple[OutputColumn, ...],
) -> tuple[OutputColumnChange, ...]:
    old_by_name = {column.name: column for column in base}
    new_by_name = {column.name: column for column in proposed}
    changes: list[OutputColumnChange] = []
    for name in sorted(old_by_name.keys() & new_by_name.keys()):
        old = old_by_name[name]
        new = new_by_name[name]
        if old.expression_ast != new.expression_ast:
            changes.append(OutputColumnChange("modified", name, name, old, new))

    old_remaining = {name: old_by_name[name] for name in old_by_name.keys() - new_by_name.keys()}
    new_remaining = {name: new_by_name[name] for name in new_by_name.keys() - old_by_name.keys()}
    new_by_expression: dict[str, list[str]] = defaultdict(list)
    for name, column in new_remaining.items():
        new_by_expression[column.expression_ast].append(name)
    paired_new: set[str] = set()
    paired_old: set[str] = set()
    for old_name in sorted(old_remaining):
        candidates = sorted(new_by_expression.get(old_remaining[old_name].expression_ast, []))
        new_name = next((name for name in candidates if name not in paired_new), None)
        if new_name is not None:
            paired_old.add(old_name)
            paired_new.add(new_name)
            changes.append(
                OutputColumnChange(
                    "renamed",
                    old_name,
                    new_name,
                    old_remaining[old_name],
                    new_remaining[new_name],
                )
            )
    for name in sorted(old_remaining.keys() - paired_old):
        changes.append(OutputColumnChange("deleted", name, None, old_remaining[name], None))
    for name in sorted(new_remaining.keys() - paired_new):
        changes.append(OutputColumnChange("added", None, name, None, new_remaining[name]))
    return tuple(changes)


def _as_table(expression: exp.Expression | None) -> exp.Table | None:
    if isinstance(expression, exp.Table):
        return expression
    if isinstance(expression, exp.Schema) and isinstance(expression.this, exp.Table):
        return expression.this
    return None


def _table_name(table: exp.Table | None) -> str:
    if table is None or not isinstance(table.this, exp.Identifier):
        return ""
    parts = [part.name.lower() for part in table.parts if isinstance(part, exp.Identifier)]
    return ".".join(parts)


def _relation_name(relation: exp.Expression) -> str:
    if isinstance(relation, exp.Table):
        return _table_name(relation) or _canonical_sql(relation)
    alias = relation.alias_or_name
    return alias.lower() if alias else _canonical_sql(relation)


def _canonical_sql(expression: exp.Expression) -> str:
    return expression.sql(
        dialect=DIALECT,
        comments=False,
        normalize=True,
        pretty=False,
    )


def _normalized_ast(expression: exp.Expression) -> str:
    def clean(value):
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, dict):
            return {
                key: clean(item)
                for key, item in value.items()
                if key not in {"m", "o"}  # source coordinates and SQL comments
            }
        return value

    normalized = expression.copy()
    for identifier in normalized.find_all(exp.Identifier):
        if not identifier.args.get("quoted"):
            identifier.set("this", identifier.name.lower())
    return json.dumps(clean(normalized.dump()), sort_keys=True, separators=(",", ":"))


def _expectation_key(expectation: Expectation) -> tuple[str, str, str | None]:
    return expectation.name, expectation.expression_ast, expectation.action


def _fingerprint(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _matching_parenthesis(sql: str, opening: int) -> int | None:
    depth = 0
    quote: str | None = None
    line_comment = False
    block_comment = False
    i = opening
    while i < len(sql):
        char = sql[i]
        following = sql[i + 1] if i + 1 < len(sql) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
            i += 1
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                i += 2
            else:
                i += 1
            continue
        if quote:
            if char == quote:
                if following == quote:
                    i += 2
                    continue
                quote = None
            elif char == "\\" and quote in {"'", '"'}:
                i += 2
                continue
            i += 1
            continue
        if char == "-" and following == "-":
            line_comment = True
            i += 2
            continue
        if char == "/" and following == "*":
            block_comment = True
            i += 2
            continue
        if char in {"'", '"', "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _split_top_level(sql: str, delimiter: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    for index, char in enumerate(sql):
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {"'", '"', "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == delimiter and depth == 0:
            parts.append(sql[start:index])
            start = index + 1
    parts.append(sql[start:])
    return [part for part in parts if part.strip()]


def _parse_error_issue(exc: ParseError, evidence: str, start_line: int) -> ParseIssue:
    error = exc.errors[0] if getattr(exc, "errors", None) else {}
    relative_line = error.get("line")
    return ParseIssue(
        code="parse_error",
        message=f"Unsupported or invalid Databricks SQL: {error.get('description') or exc}",
        line=start_line + relative_line - 1 if relative_line else start_line,
        column=error.get("col"),
        evidence=error.get("highlight") or evidence[:500],
    )


def _offset_issues(issues: tuple[ParseIssue, ...], line_offset: int) -> tuple[ParseIssue, ...]:
    if not line_offset:
        return issues
    return tuple(
        ParseIssue(
            code=issue.code,
            message=issue.message,
            severity=issue.severity,
            line=issue.line + line_offset if issue.line else None,
            column=issue.column,
            evidence=issue.evidence,
        )
        for issue in issues
    )


def _line_column(sql: str, offset: int) -> tuple[int, int]:
    line = sql.count("\n", 0, offset) + 1
    previous_newline = sql.rfind("\n", 0, offset)
    return line, offset - previous_newline
