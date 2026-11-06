import { $$, attr, children, text } from "justdom-core";

/** What an SVG element's attributes may be set to. */
export type SvgAttributes = Record<string, string | number>;

/**
 * An SVG element with its attributes and children, for the panels whose
 * pictures are long runs of markup. `class` is set as an attribute: on an
 * SVG element the `className` property is an `SVGAnimatedString`, not a
 * string to assign.
 */
export function svg(
  tag: keyof SVGElementTagNameMap,
  attributes: SvgAttributes = {},
  ...kids: ReturnType<typeof $$>[]
): ReturnType<typeof $$> {
  return $$(tag, [attr(attributes), children(...kids)]);
}

/** A `<text>` element with one run of text in it. */
export function svgText(attributes: SvgAttributes, words: string): ReturnType<typeof $$> {
  return $$("text", [attr(attributes), children(text`${words}`)]);
}
