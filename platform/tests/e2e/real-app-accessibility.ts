import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

export interface ContrastProbe {
  readonly name: string
  readonly locator: Locator
}

export interface MotionProbe {
  readonly name: string
  readonly locator: Locator
}

export interface SourceDrawerProbe {
  readonly dialog: Locator
  readonly trigger: Locator
}

export interface SourceDrawerKeyboardEvidence {
  readonly first: string
  readonly last: string
  readonly focusReturned: boolean
}

export interface AccessibilityReport {
  readonly state: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly labels: readonly { readonly name: string; readonly visibleLabel: string; readonly accessibleSnapshot: string }[]
  readonly contrast: readonly { readonly name: string; readonly foreground: string; readonly background: string; readonly ratio: number; readonly minimum: number }[]
  readonly reducedMotion: { readonly mediaMatches: boolean; readonly probes: readonly { readonly name: string; readonly animationDuration: string; readonly transitionDuration: string; readonly maximumAnimationMs: number; readonly maximumTransitionMs: number }[] }
  readonly nonTextControlBoundaries: { readonly measured: false; readonly note: string }
  readonly drawer?: SourceDrawerKeyboardEvidence
}

/** Test the actual open source drawer with native keyboard input and return focus evidence. */
export async function collectRealAppDrawerEvidence(page: Page, probe: SourceDrawerProbe): Promise<SourceDrawerKeyboardEvidence> {
  const { dialog, trigger } = probe
  await expect(dialog).toBeVisible()
  const focusable = dialog.locator('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')
  const entries = await focusable.evaluateAll((nodes) => nodes.map((node, index) => ({ node, index })).filter(({ node }) => {
    if (!(node instanceof HTMLElement)) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0 && node.tabIndex >= 0 && node.closest('[inert]') === null
  }).map(({ node, index }) => ({ index, name: (node as HTMLElement).innerText.trim() || (node as HTMLElement).getAttribute('aria-label') || (node as HTMLElement).tagName })))
  expect(entries.length, 'source drawer needs visible keyboard-focusable controls').toBeGreaterThan(0)
  expect(await dialog.evaluate((node) => node.contains(document.activeElement)), 'focus should enter source drawer').toBe(true)
  for (let step = 0; step < entries.length; step += 1) {
    if (await focusable.nth(entries[0]!.index).evaluate((node) => node === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(focusable.nth(entries[0]!.index)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(focusable.nth(entries[entries.length - 1]!.index)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(focusable.nth(entries[0]!.index)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  return { first: entries[0]!.name, last: entries[entries.length - 1]!.name, focusReturned: true }
}

/**
 * Collect focused evidence from the actual visible App state supplied by the caller.
 * This reports sampled checks only; it does not claim blanket WCAG conformance.
 */
export async function collectRealAppAccessibilityEvidence(page: Page, options: {
  readonly state: string
  readonly visibleControls: readonly { readonly name: string; readonly locator: Locator }[]
  readonly contrastProbes: readonly ContrastProbe[]
  readonly motionProbes: readonly MotionProbe[]
  readonly sourceDrawer?: SourceDrawerProbe
}): Promise<AccessibilityReport> {
  expect(options.visibleControls.length, `${options.state}: provide visible controls to inspect`).toBeGreaterThan(0)
  expect(options.contrastProbes.length, `${options.state}: provide contrast probes to inspect`).toBeGreaterThan(0)
  expect(options.motionProbes.length, `${options.state}: provide reduced-motion probes to inspect`).toBeGreaterThan(0)
  const labels = [] as { name: string; visibleLabel: string; accessibleSnapshot: string }[]
  for (const control of options.visibleControls) {
    await expect(control.locator, `${options.state}: ${control.name} should be visible`).toBeVisible()
    const evidence = await control.locator.evaluate((node) => {
      if (!(node instanceof HTMLElement)) throw new Error('control is not an HTMLElement')
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
      }
      const associated = node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement
        ? Array.from(node.labels ?? []).filter(visible).map((label) => label.innerText.trim()).filter(Boolean)
        : []
      return { visibleLabel: associated.join(' ').trim() }
    })
    expect(evidence.visibleLabel, `${options.state}: ${control.name} needs a visible associated label`).not.toBe('')
    await expect(control.locator, `${options.state}: ${control.name} needs an accessible name`).toHaveAccessibleName(/\S+/)
    labels.push({ name: control.name, ...evidence, accessibleSnapshot: await control.locator.ariaSnapshot() })
  }

  const contrast = [] as AccessibilityReport['contrast'][number][]
  for (const probe of options.contrastProbes) {
    await expect(probe.locator, `${options.state}: ${probe.name} should be visible`).toBeVisible()
    const inactive = await probe.locator.evaluate((node) => node instanceof HTMLElement && node.matches(':disabled, [aria-disabled="true"]'))
    if (inactive) continue
    const measurement = await probe.locator.evaluate((node) => {
      if (!(node instanceof HTMLElement)) throw new Error('contrast probe is not an HTMLElement')
      const parse = (value: string): [number, number, number, number] | undefined => {
        const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/)
        if (match === null) return undefined
        const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4])
        return [Number(match[1]), Number(match[2]), Number(match[3]), alpha]
      }
      const composite = (front: [number, number, number, number], back: [number, number, number, number]): [number, number, number, number] => {
        const alpha = front[3] + back[3] * (1 - front[3])
        if (alpha === 0) return [0, 0, 0, 0]
        return [0, 1, 2].map((index) => (front[index]! * front[3] + back[index]! * back[3] * (1 - front[3])) / alpha).concat(alpha) as [number, number, number, number]
      }
      const foreground = parse(getComputedStyle(node).color)
      if (foreground === undefined) throw new Error(`unsupported foreground paint: ${getComputedStyle(node).color}`)
      let background: [number, number, number, number] = [255, 255, 255, 1]
      const chain: Element[] = []
      for (let current: Element | null = node; current !== null; current = current.parentElement) chain.push(current)
      for (const element of chain.reverse()) {
        const style = getComputedStyle(element)
        if (style.backgroundImage !== 'none' || style.mixBlendMode !== 'normal' || Number(style.opacity) !== 1) {
          throw new Error(`unsupported background compositing on ${element.tagName}: image=${style.backgroundImage}, blend=${style.mixBlendMode}, opacity=${style.opacity}`)
        }
        const paint = style.backgroundColor
        const parsed = parse(paint)
        if (parsed === undefined) throw new Error(`unsupported background paint: ${paint}`)
        background = composite(parsed, background)
      }
      const visibleForeground = composite(foreground, background)
      const luminance = (color: [number, number, number, number]): number => {
        const channels = color.slice(0, 3).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
      }
      const fgL = luminance(visibleForeground)
      const bgL = luminance(background)
      const ratio = (Math.max(fgL, bgL) + 0.05) / (Math.min(fgL, bgL) + 0.05)
      const style = getComputedStyle(node)
      const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number.parseInt(style.fontWeight, 10) >= 700)
      return { foreground: style.color, background: `rgb(${background[0]}, ${background[1]}, ${background[2]})`, ratio, minimum: large ? 3 : 4.5 }
    })
    expect(measurement.ratio, `${options.state}: ${probe.name} contrast`).toBeGreaterThanOrEqual(measurement.minimum)
    contrast.push({ name: probe.name, foreground: measurement.foreground, background: measurement.background, ratio: measurement.ratio, minimum: measurement.minimum })
  }
  expect(contrast.length, `${options.state}: provide at least one active contrast sample`).toBeGreaterThan(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mediaMatches = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  expect(mediaMatches, `${options.state}: reduced-motion media preference`).toBe(true)
  const motion = [] as { name: string; animationDuration: string; transitionDuration: string; maximumAnimationMs: number; maximumTransitionMs: number }[]
  for (const probe of options.motionProbes) {
    await expect(probe.locator, `${options.state}: motion probe ${probe.name} should be visible`).toBeVisible()
    const durations = await probe.locator.evaluate((node) => {
      const style = getComputedStyle(node)
      const maximumMs = (value: string): number => {
        const values = value.split(',').map((duration) => {
          const match = duration.trim().match(/^((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(ms|s)$/i)
          if (match === null) throw new Error(`unsupported computed duration: ${duration}`)
          return Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1)
        })
        return Math.max(...values)
      }
      return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration,
        maximumAnimationMs: maximumMs(style.animationDuration), maximumTransitionMs: maximumMs(style.transitionDuration) }
    })
    expect(durations.maximumAnimationMs, `${options.state}: ${probe.name} animation duration`).toBeLessThanOrEqual(1)
    expect(durations.maximumTransitionMs, `${options.state}: ${probe.name} transition duration`).toBeLessThanOrEqual(1)
    motion.push({ name: probe.name, ...durations })
  }

  let drawer: AccessibilityReport['drawer']
  if (options.sourceDrawer !== undefined) {
    drawer = await collectRealAppDrawerEvidence(page, options.sourceDrawer)
  }

  return { state: options.state, viewport: page.viewportSize() ?? { width: 0, height: 0 }, labels, contrast,
    reducedMotion: { mediaMatches, probes: motion },
    nonTextControlBoundaries: { measured: false, note: 'Control and focus-indicator boundary contrast is not sampled by this text-contrast helper.' },
    ...(drawer === undefined ? {} : { drawer }) }
}
