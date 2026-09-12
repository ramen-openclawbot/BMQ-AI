export const files = [
  ...['AttendanceManagement','PayrollManagement','Settings','UserManagement','SystemManagement'].map(n=>`src/pages/${n}.tsx`),
  'src/components/attendance/ShiftPlannerGrid.tsx','src/components/payroll/PayrollExportPanel.tsx',
  ...['AppVersionSection','GoogleDriveSettings','DataMigrationSettings','DealerPortalBannerSettings','DriveSyncSection'].map(n=>`src/components/settings/${n}.tsx`),
  'src/hooks/useUserManagement.ts','src/hooks/useDriveSync.ts',
];
