// Helpers for projecting JournL responses onto the fields a tool returns.

/** Copies the listed fields (outName: sourceName), skipping absent ones. */
export function pick(source, fields) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const [to, from] of Object.entries(fields)) if (source[from] !== undefined) out[to] = source[from];
  return out;
}

/** Projects a list, keeping at most `limit` rows and recording what was cut in `truncated`. */
export function rows(list, limit, name, truncated, project) {
  const all = Array.isArray(list) ? list : [];
  if (all.length > limit) truncated.push({ list: name, returned: limit, total: all.length });
  return all.slice(0, limit).map(project);
}

/** Caps every nested list; for data whose shape JournL does not document. */
export function capLists(value, limit, path, truncated) {
  if (Array.isArray(value)) {
    if (value.length > limit) truncated.push({ list: path, returned: limit, total: value.length });
    return value.slice(0, limit).map((item, i) => capLists(item, limit, `${path}[${i}]`, truncated));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = capLists(child, limit, `${path}.${key}`, truncated);
    return out;
  }
  return value;
}
