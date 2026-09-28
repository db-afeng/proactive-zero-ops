"""Public report rendering.

Detailed guard results are restricted evidence and deliberately have no
GitHub report renderer.
"""

from lineage_guard.disclosure import (
    PUBLIC_MARKER,
    PublicDisclosure,
    render_public_markdown,
)

MARKER = PUBLIC_MARKER


def render_markdown(disclosure: PublicDisclosure) -> str:
    return render_public_markdown(disclosure)
