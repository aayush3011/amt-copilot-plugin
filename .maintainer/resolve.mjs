export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || /^(?:[./]|[a-z][a-z\d+.-]*:)/i.test(specifier)) throw error;
    return nextResolve(specifier, { ...context, parentURL: new URL('./package.json', import.meta.url).href });
  }
}
