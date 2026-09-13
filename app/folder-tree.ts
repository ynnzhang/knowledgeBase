export type TreeNote = { id: string; path: string; name: string };
export type FolderNode<T extends TreeNote> = {
  name: string;
  path: string;
  folders: Map<string, FolderNode<T>>;
  notes: T[];
  document?: T;
};

// Feishu parent pages are stored as siblings: Topic.md and Topic/child.md.
// Associate them only in the view; note identities and disk paths stay intact.
export function buildFolderTree<T extends TreeNote>(notes: T[], folderPaths: string[], matchingIds?: ReadonlySet<string>): FolderNode<T> {
  const root: FolderNode<T> = { name: '知识库', path: '', folders: new Map(), notes: [] };
  const folders = new Map<string, FolderNode<T>>([['', root]]);
  const normalize = (value: string) => value.replaceAll('\\', '/');
  function ensureFolder(folderPath: string) {
    let current = root;
    for (const name of normalize(folderPath).split('/').filter(Boolean)) {
      const path = current.path ? `${current.path}/${name}` : name;
      let child = folders.get(path);
      if (!child) { child = { name, path, folders: new Map(), notes: [] }; folders.set(path, child); current.folders.set(name, child); }
      current = child;
    }
    return current;
  }
  for (const path of folderPaths) ensureFolder(path);
  // Materialize all actual ancestors before checking any parent document.
  for (const note of notes) ensureFolder(normalize(note.path).split('/').slice(0, -1).join('/'));
  const candidates = new Map<string, T[]>();
  for (const note of notes) {
    const path = normalize(note.path);
    if (!/\.md(?:own)?$/i.test(path)) continue;
    const stem = path.replace(/\.md(?:own)?$/i, '');
    if (folders.has(stem)) { const matches = candidates.get(stem) || []; matches.push(note); candidates.set(stem, matches); }
  }
  const documents = new Set<string>();
  for (const [path, matches] of candidates) {
    // Ambiguous .md / .mdown pairs remain visible so no note loses its entry.
    if (matches.length !== 1) continue;
    folders.get(path)!.document = matches[0]; documents.add(matches[0].id);
  }
  for (const note of notes) {
    if (!documents.has(note.id)) ensureFolder(normalize(note.path).split('/').slice(0, -1).join('/')).notes.push(note);
  }
  if (matchingIds) {
    function filter(folder: FolderNode<T>): boolean {
      folder.notes = folder.notes.filter((note) => matchingIds!.has(note.id));
      for (const [name, child] of folder.folders) if (!filter(child)) folder.folders.delete(name);
      // A child match keeps the folder's document available in its context menu.
      return Boolean(folder.notes.length || folder.folders.size || (folder.document && matchingIds!.has(folder.document.id)));
    }
    filter(root);
  }
  return root;
}
