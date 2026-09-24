import type { CredentialStore } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/** Use current OAuth credentials without the file-backed store's write lock. */
export function readOnlyProbeCredentials(provider: string, authPath: string): CredentialStore {
  const store: CredentialStore = {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      if (providerId !== provider) return undefined;
      const credential = readStoredCredential(providerId, authPath);
      if (credential?.type !== "oauth" || typeof credential.access !== "string" ||
          typeof credential.refresh !== "string" || !Number.isFinite(credential.expires)) return undefined;
      return credential;
    },
    async list(options) {
      const credential = await store.read(provider, options);
      return credential ? [{ providerId: provider, type: credential.type }] : [];
    },
    async modify(_providerId, _fn, options) {
      options?.signal?.throwIfAborted();
      // Do not invoke the refresh callback: rotating a token without persisting it
      // could invalidate the user's stored credentials. Refresh in Pi instead.
      throw new Error("probe_requires_current_credentials");
    },
    async delete(_providerId, options) {
      options?.signal?.throwIfAborted();
      throw new Error("probe_credentials_read_only");
    },
  };
  return store;
}
