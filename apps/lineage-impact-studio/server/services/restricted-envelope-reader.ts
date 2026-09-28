import { parseAssessmentReference } from '../domain/identifiers';

const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

export class RestrictedEnvelopeReadError extends Error {
  override readonly name = 'RestrictedEnvelopeReadError';

  constructor() {
    super('Restricted assessment envelope could not be read');
  }
}

export interface VolumeReader {
  read(filePath: string, options?: { maxSize?: number }): Promise<string>;
}

/**
 * Reads an envelope through the service-principal AppKit volume handle.
 * The corresponding Files policy denies every end-user HTTP operation.
 */
export class VolumeRestrictedEnvelopeReader {
  readonly #volume: VolumeReader;

  constructor(volume: VolumeReader) {
    this.#volume = volume;
  }

  async read(reference: string): Promise<Uint8Array> {
    try {
      const safeReference = parseAssessmentReference(reference);
      const contents = await this.#volume.read(`${safeReference}.json`, {
        maxSize: MAX_ENVELOPE_BYTES,
      });
      const bytes = new TextEncoder().encode(contents);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
        throw new RestrictedEnvelopeReadError();
      }
      return bytes;
    } catch (error) {
      if (error instanceof RestrictedEnvelopeReadError) throw error;
      throw new RestrictedEnvelopeReadError();
    }
  }
}
