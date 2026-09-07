// fake-indexeddb gives the storage layer a real IndexedDB implementation under
// Node, so db tests exercise the same code path the extension runs in Chrome.
import 'fake-indexeddb/auto';
