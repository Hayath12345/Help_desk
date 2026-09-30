// The admin kit (docs/PHASE4_CONTRACT.md E1–E4, E19): the building blocks every admin section
// uses. Data helpers live in lib/admin (keys, fetchers, useAdminList / useAdminMutation).

export { AdminSectionHeader, type AdminSectionHeaderProps } from './admin-section-header';
export { AdminSheet, type AdminSheetProps } from './admin-sheet';
export {
  AdminTable,
  focusRowNear,
  type AdminTableColumn,
  type AdminTableProps,
} from './admin-table';
export { ArchivedBadge } from './archived-badge';
export {
  BilingualField,
  RhfBilingualField,
  type BilingualFieldProps,
  type RhfBilingualFieldProps,
} from './bilingual-field';
export { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';
export { InlineEditor, useListFocus, type InlineEditorProps } from './inline-editor';
export { CreateNewButton, type CreateNewButtonProps } from './create-new-button';
export { KeyField, type KeyFieldProps } from './key-field';
export {
  LanguageSwitch,
  LanguageTag,
  contentLanguageProps,
  type ContentLanguage,
  type LanguageSwitchProps,
} from './language-switch';
export {
  DragHandle,
  ReorderAnnouncer,
  ReorderButtons,
  ReorderList,
  useReorder,
  type ReorderHandler,
  type ReorderListProps,
  type ReorderState,
} from './reorder';
export { WhoCanSeeNote, type WhoCanSeeAudience, type WhoCanSeeNoteProps } from './who-can-see-note';
