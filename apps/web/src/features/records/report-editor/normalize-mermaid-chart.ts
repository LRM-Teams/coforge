/**
 * Repair Worker-prompt lookalike arrows (‹ ›) that break Mermaid parse.
 * Period Brief used to escape every ">" in collector packs, rewriting `-->`
 * into `--›`; agents then copied the broken arrows into notes.
 */
export function normalizeMermaidChart(chart: string): string {
  return chart
    .replaceAll("‹--›", "<-->")
    .replaceAll("--›", "-->")
    .replaceAll("==›", "==>")
    .replaceAll("-.-›", "-.->")
    .replaceAll("~~~›", "~~~>")
    .replaceAll("‹--", "<--")
    .replaceAll("‹==", "<==");
}

/**
 * Mermaid `htmlLabels` emit HTML void tags (`<br>`) inside SVG `foreignObject`
 * XHTML. That is valid HTML but not well-formed XML, so Chromium paints
 * "Unexpected closing tag: p != br" instead of the diagram. Normalize the
 * common void tags Mermaid uses before embedding the SVG in the sandbox iframe.
 *
 * @see https://github.com/mermaid-js/mermaid/issues/1766
 */
export function sanitizeMermaidSvg(svg: string): string {
  return svg
    .replace(/<br\s*>/gi, "<br/>")
    .replace(/<\/br>/gi, "")
    .replace(/<hr\s*>/gi, "<hr/>")
    .replace(/<\/hr>/gi, "");
}
