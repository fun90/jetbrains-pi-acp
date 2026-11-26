// ACP 约定的 JSON-RPC 错误码。
const error = code => message => Object.assign(new Error(message), { code });

export const invalid = error(-32602);
export const methodNotFound = error(-32601);
export const authRequired = error(-32000);
export const notFound = error(-32002);
export const cancelled = error(-32800);
