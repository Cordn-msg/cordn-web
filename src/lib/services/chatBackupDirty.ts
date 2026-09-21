/**
 * Dirty flag for automated backups — a leaf module so the persistence choke points
 * (chatGroups / chatCoordinators / accountManager) can mark it without importing the
 * automation service (which imports chatBackup, which imports those services — a cycle
 * if the flag lived there; as a leaf it is cycle-free in every direction).
 *
 * Starts true: a fresh app start with automation enabled should run one backup without
 * waiting for new writes (covers anything that changed while the app was closed).
 */

let dirty = true;

export function markBackupDirty(): void {
	dirty = true;
}

export function clearBackupDirty(): void {
	dirty = false;
}

export function isBackupDirty(): boolean {
	return dirty;
}
