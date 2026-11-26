// Builds a per-window Firefox theme tinted with the space's color.

const hexToRgb = (hex) => {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [94, 129, 244];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const css = (c) => `rgb(${c.join(', ')})`;

export function buildTheme(hex, dark) {
  const c = hexToRgb(hex);
  const base = dark ? [28, 27, 34] : [255, 255, 255];
  const text = dark ? [251, 251, 254] : [21, 20, 26];
  const frame = mix(c, base, dark ? 0.74 : 0.72);
  const toolbar = mix(c, base, dark ? 0.84 : 0.86);
  const field = mix(c, base, dark ? 0.92 : 0.96);
  const line = mix(c, base, dark ? 0.6 : 0.65);
  return {
    colors: {
      frame: css(frame),
      frame_inactive: css(mix(frame, base, 0.35)),
      tab_background_text: css(text),
      tab_selected: css(toolbar),
      tab_text: css(text),
      tab_line: css(c),
      toolbar: css(toolbar),
      toolbar_text: css(text),
      toolbar_top_separator: css(toolbar),
      toolbar_bottom_separator: css(line),
      toolbar_field: css(field),
      toolbar_field_focus: css(field),
      toolbar_field_text: css(text),
      toolbar_field_text_focus: css(text),
      icons: css(text),
      sidebar: css(mix(c, base, dark ? 0.86 : 0.9)),
      sidebar_text: css(text),
      sidebar_border: css(line),
      popup: css(dark ? [43, 42, 51] : [255, 255, 255]),
      popup_text: css(text),
    },
  };
}
