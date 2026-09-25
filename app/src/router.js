/**
 * Mini-router declarativo com suporte a parâmetros de caminho (:param) e prefixos.
 *
 * Uso:
 *   const router = createRouter();
 *   router.add('GET', '/api/items', handler);
 *   router.add('GET', '/api/items/:id', handler);
 *   router.prefix('*', '/api/proxy', proxyHandler);
 *
 *   const match = router.match('GET', '/api/items/42');
 *   // match => { handler, params: { id: '42' } }
 */

/**
 * @typedef {{ handler: Function, params: Record<string, string> }} RouteMatch
 */

/**
 * Cria um novo roteador.
 */
export function createRouter() {
  /** @type {Array<{ method: string, segments: (string|null)[], paramNames: string[], handler: Function, isPrefix: boolean }>} */
  const routes = [];

  /**
   * Registra uma rota exata.
   * @param {string} method - Método HTTP (GET, POST, PUT, DELETE, *).
   * @param {string} path - Caminho (ex: /api/users/:id/activate).
   * @param {Function} handler - Handler(request, response, url, params).
   */
  function add(method, path, handler) {
    const parts = path.split('/').filter(Boolean);
    const paramNames = [];
    const segments = parts.map(part => {
      if (part.startsWith(':')) {
        paramNames.push(part.slice(1));
        return null;
      }
      return part;
    });
    routes.push({ method, segments, paramNames, handler, isPrefix: false });
  }

  /**
   * Registra uma rota que aceita qualquer sufixo (para proxying).
   * @param {string} method - Método HTTP ou '*' para todos.
   * @param {string} path - Prefixo (ex: /api/proxy).
   * @param {Function} handler - Handler(request, response, url, params).
   */
  function prefix(method, path, handler) {
    const parts = path.split('/').filter(Boolean);
    routes.push({ method, segments: parts, paramNames: [], handler, isPrefix: true });
  }

  /**
   * Encontra o handler que corresponde ao método e pathname fornecidos.
   * @param {string} method
   * @param {string} pathname
   * @returns {RouteMatch|null}
   */
  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== '*' && route.method !== method) continue;
      if (route.isPrefix) {
        if (parts.length < route.segments.length) continue;
        let ok = true;
        for (let i = 0; i < route.segments.length; i++) {
          if (route.segments[i] !== parts[i]) { ok = false; break; }
        }
        if (ok) return { handler: route.handler, params: {} };
        continue;
      }
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      let pi = 0;
      for (let i = 0; i < route.segments.length; i++) {
        if (route.segments[i] === null) {
          params[route.paramNames[pi++]] = parts[i];
        } else if (route.segments[i] !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  const get = (path, handler) => add('GET', path, handler);
  const post = (path, handler) => add('POST', path, handler);
  const put = (path, handler) => add('PUT', path, handler);
  const del = (path, handler) => add('DELETE', path, handler);
  const patch = (path, handler) => add('PATCH', path, handler);

  return { add, prefix, match, get, post, put, delete: del, patch };
}
