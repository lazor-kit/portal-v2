export interface Credential {
    credentialId: string;
    publicKey: string;
    accountName: string;
}

export function getStoredCredentials(): Credential[] {
    const credentialId = localStorage.getItem("CREDENTIAL_ID");
    const publicKey = localStorage.getItem("PUBLIC_KEY");
    const accountName = localStorage.getItem("ACCOUNT_NAME") || "Account 1";

    // If we have credentialId, return it (publicKey can be empty for signIn case)
    return credentialId ? [{ credentialId, publicKey: publicKey || '', accountName }] : [];
}

export function saveCredential(credentialId: string, publicKey: string, accountName: string = "Account 1"): void {
    localStorage.setItem("CREDENTIAL_ID", credentialId);
    localStorage.setItem("PUBLIC_KEY", publicKey);
    localStorage.setItem("ACCOUNT_NAME", accountName);
    localStorage.setItem("WALLET_STATUS", "TRUE");
}

// Save credential with only credentialId (for signIn operations)
export function saveCredentialId(credentialId: string): void {
    localStorage.setItem("CREDENTIAL_ID", credentialId);
    localStorage.setItem("WALLET_STATUS", "TRUE");
    // Don't save PUBLIC_KEY since we don't have it during signIn
}
