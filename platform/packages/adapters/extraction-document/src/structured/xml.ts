export type XmlToken =
  | {
      readonly kind: 'start'
      readonly name: string
      readonly localName: string
      readonly attrs: ReadonlyMap<string, string>
      readonly selfClosing: boolean
    }
  | { readonly kind: 'end'; readonly name: string; readonly localName: string }
  | { readonly kind: 'text'; readonly value: string }

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, token: string) => {
    if (token.startsWith('#x') || token.startsWith('#X')) {
      const code = Number.parseInt(token.slice(2), 16)
      return Number.isNaN(code) ? match : String.fromCodePoint(code)
    }
    if (token.startsWith('#')) {
      const code = Number.parseInt(token.slice(1), 10)
      return Number.isNaN(code) ? match : String.fromCodePoint(code)
    }
    return ENTITIES[token] ?? match
  })
}

function localNameOf(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

function findTagEnd(xml: string, from: number): number {
  let quote: string | undefined
  for (let i = from; i < xml.length; i += 1) {
    const char = xml[i]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return i
    }
  }
  return -1
}

const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

function parseTag(body: string): { name: string; attrs: Map<string, string> } {
  let cursor = 0
  while (cursor < body.length && /\s/.test(body[cursor] ?? '')) cursor += 1
  let nameEnd = cursor
  while (nameEnd < body.length && !/[\s/]/.test(body[nameEnd] ?? '')) nameEnd += 1
  const name = body.slice(cursor, nameEnd)
  const attrs = new Map<string, string>()
  const rest = body.slice(nameEnd)
  ATTRIBUTE.lastIndex = 0
  let match = ATTRIBUTE.exec(rest)
  while (match !== null) {
    const attrName = match[1] ?? ''
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    attrs.set(attrName, decodeXmlEntities(value))
    match = ATTRIBUTE.exec(rest)
  }
  return { name, attrs }
}

/**
 * A minimal, allocation-light XML scanner for OOXML parts. It yields start/end/
 * text tokens and skips declarations, comments and processing instructions. It is
 * deliberately not a general DOM: XLSX parsing only needs the elements it names.
 */
export function* scanXml(xml: string): Generator<XmlToken> {
  let i = 0
  const n = xml.length
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      if (i < n) yield { kind: 'text', value: decodeXmlEntities(xml.slice(i)) }
      return
    }
    if (lt > i) yield { kind: 'text', value: decodeXmlEntities(xml.slice(i, lt)) }

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end < 0) return
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const text = end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end)
      yield { kind: 'text', value: text }
      if (end < 0) return
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end < 0) return
      i = end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2)
      if (end < 0) return
      i = end + 1
      continue
    }

    const tagEnd = findTagEnd(xml, lt + 1)
    if (tagEnd < 0) return
    const raw = xml.slice(lt + 1, tagEnd)
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim()
      yield { kind: 'end', name, localName: localNameOf(name) }
    } else {
      const selfClosing = raw.endsWith('/')
      const parsed = parseTag(selfClosing ? raw.slice(0, -1) : raw)
      yield {
        kind: 'start',
        name: parsed.name,
        localName: localNameOf(parsed.name),
        attrs: parsed.attrs,
        selfClosing,
      }
    }
    i = tagEnd + 1
  }
}
