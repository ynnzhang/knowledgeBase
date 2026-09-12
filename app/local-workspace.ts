// Bind every request to the vault that this tab loaded, so switching directories
// in another tab cannot save an old draft into a same-named file in the new vault.
let workspace = '';
export const setLocalWorkspace = (value: string) => { workspace = value; };
export const localWorkspaceToken = () => encodeURIComponent(workspace);
export const workspaceHeaders = (): Record<string, string> => workspace ? { 'X-Zhixu-Workspace': localWorkspaceToken() } : {};
