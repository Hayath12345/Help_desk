// Admin data layer (docs/PHASE4_CONTRACT.md E18–E20). Components: components/admin/kit.
export {
  adminListFetcher,
  adminGet,
  adminPath,
  adminWrite,
  withExpectedUpdatedAt,
  type AdminWriteMethod,
} from './api';
export { adminConflictDetails, applyServerIssues, isStaleConflict } from './errors';
export {
  reorderById,
  useAdminList,
  useAdminMutation,
  type AdminListOptions,
  type AdminMutationOptions,
} from './hooks';
export { suggestKey, type KeySuggestionOptions } from './key-suggestion';
export { adminKeys, normalizeAdminParams, type AdminListParams } from './keys';
export {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_NAMESPACE,
  ADMIN_SLUGS,
  allowedAdminGroups,
  allowedAdminSections,
  canOpenAdminSection,
  isAdminSection,
  type AdminNavGroupId,
  type AdminSlug,
} from './sections';
