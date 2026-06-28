// client/level-panels.ts
// DOM builders for the inspector. Each appends a labelled control to `host` and invokes a callback
// on edit. Kept free of three.js so they're trivial to reason about and reuse across sections.
export function numberRow(host: HTMLElement, label: string, value: number,
  min: number, max: number, step: number, onInput: (v: number) => void): void {
  const l = document.createElement('label'); l.textContent = label;
  const inp = document.createElement('input'); inp.type = 'range';
  inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
  const num = document.createElement('input'); num.type = 'number'; num.value = String(value); num.step = String(step);
  const sync = (v: number) => { inp.value = String(v); num.value = String(v); onInput(v); };
  inp.oninput = () => sync(parseFloat(inp.value));
  num.oninput = () => sync(parseFloat(num.value));
  l.append(inp, num); host.append(l);
}

export function colorRow(host: HTMLElement, label: string, hex: string, onInput: (hex: string) => void): void {
  const l = document.createElement('label'); l.textContent = label;
  const c = document.createElement('input'); c.type = 'color'; c.value = hex;
  c.oninput = () => onInput(c.value);
  l.append(c); host.append(l);
}

export function heading(host: HTMLElement, text: string): void {
  const h = document.createElement('h4'); h.textContent = text; host.append(h);
}
