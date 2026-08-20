export function createRosterSourceRegistry(initialSources = []) {
  const sources = new Map();

  const register = (source) => {
    if (!source?.id || typeof source.collect !== "function") {
      throw new TypeError("A roster source requires an id and collect(context) function.");
    }
    sources.set(source.id, Object.freeze({ ...source }));
    return source.id;
  };

  const collect = async (id, context) => {
    const source = sources.get(id);
    if (!source) throw new Error(`Unknown roster source: ${id}`);
    const result = await source.collect(context);
    return {
      members: [],
      complete: false,
      reason: `${id}-no-result`,
      ...result,
      source: id,
    };
  };

  for (const source of initialSources) register(source);
  return Object.freeze({
    register,
    collect,
    has: (id) => sources.has(id),
    list: () => [...sources.values()],
  });
}
