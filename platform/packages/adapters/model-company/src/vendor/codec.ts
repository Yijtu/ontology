import type { CompanyModelProtocol } from '../types'
import { decodeCompanyWireChunk } from './company-wire'
import type { CompanyWireChunk } from './company-wire'
import { OpenAiStreamCodec } from './openai-wire'

/**
 * @internal Wire codec seam.
 *
 * A codec translates one provider's SSE `data:` payloads into the adapter's single
 * internal chunk union. After this seam the adapter is protocol-agnostic: it maps the
 * same chunks to canonical `GenerationEvent`s and never sees a provider field name. This
 * keeps the two protocols as explicit, separately tested strategies instead of branching
 * the decode logic inline.
 *
 * `decode` returns `undefined` for a payload the codec does not recognise (the adapter
 * classifies that as an upstream protocol fault rather than dropping it). `finish`
 * flushes state that only becomes complete at end-of-stream, such as fragmented
 * tool-call arguments.
 */
export interface WireCodec {
  decode(payload: string): readonly CompanyWireChunk[] | undefined
  finish(): readonly CompanyWireChunk[]
}

class PrivateWireCodec implements WireCodec {
  decode(payload: string): readonly CompanyWireChunk[] | undefined {
    const chunk = decodeCompanyWireChunk(payload)
    return chunk === undefined ? undefined : [chunk]
  }

  finish(): readonly CompanyWireChunk[] {
    return []
  }
}

/** Select the codec for the configured protocol. Defaults to the original private path. */
export function createWireCodec(protocol: CompanyModelProtocol | undefined): WireCodec {
  return protocol === 'openai-compatible' ? new OpenAiStreamCodec() : new PrivateWireCodec()
}
