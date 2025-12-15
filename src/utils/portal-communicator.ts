import { isIframe } from "./credentialSync"

export type PortalEnvironment = "browser" | "expo" | "unknown"
export type PortalAction = "connect" | "sign" | "unknown"

export interface PortalParams {
    action: PortalAction
    message: string
    autoConnect: boolean
    autoSign: boolean
    expoParam: string | null
    redirectUrl: string | null
    credentialId: string | null
    accountName: string | null
    transaction: string | null
    clusterSimulation: string | null
}

export interface PortalResponse {
    type: "WALLET_CONNECTED" | "WALLET_CONNECTED_WITH_SIGNIN" | "WALLET_CONNECTED" | "SIGNATURE_CREATED" | "error"
    data?: any
    error?: string
    details?: string
    credentialId?: string
    publickey?: string
    accountName?: string
    timestamp?: string
    environment?: string
    platform?: string
    expo?: string | null
}

export class PortalCommunicator {

    static detectEnvironment(): PortalEnvironment {
        if (typeof window !== "undefined") {
            const urlParams = new URLSearchParams(window.location.search)
            // If 'expo' param/scheme is present, we are in an Expo AuthSession flow in a browser
            if (urlParams.get('expo')) {
                return "expo"
            }

            if (window.location.protocol === "file:" ||
                window.navigator.userAgent.includes("expo") ||
                window.navigator.userAgent.includes("ExponentJS")) {
                return "expo"
            }

            return "browser"
        }
        return "unknown"
    }

    static getParams(): PortalParams {
        if (typeof window === "undefined") {
            return { action: 'unknown', message: '', autoConnect: false, autoSign: false, expoParam: null, redirectUrl: null, credentialId: null, accountName: null, transaction: null, clusterSimulation: null }
        }
        const urlParams = new URLSearchParams(window.location.search)
        const actionParam = urlParams.get('action')

        let action: PortalAction = 'unknown'
        if (actionParam === 'connect') action = 'connect'
        if (actionParam === 'sign') action = 'sign'

        return {
            action,
            message: urlParams.get('message') || '',
            autoConnect: urlParams.get('auto_connect') === 'true',
            autoSign: urlParams.get('auto_sign') === 'true',
            expoParam: urlParams.get('expo') || null,
            redirectUrl: urlParams.get('redirectUrl') || urlParams.get('redirect_url') || null,
            credentialId: urlParams.get('credentialId') || null,
            accountName: urlParams.get('accountName') || null,
            transaction: urlParams.get('transaction') || null,
            clusterSimulation: urlParams.get('clusterSimulation') || null
        }
    }

    static async reply(response: PortalResponse, params: PortalParams) {
        const env = PortalCommunicator.detectEnvironment()
        console.log("PortalCommunicator replying:", response, "Env:", env)

        // Construct effective data payload from both .data and top-level props
        // This ensures compatibility with both Expo (redirect) and DialogManager (postMessage)
        const effectiveData = {
            ...(response.data || {}),
            ...(response.credentialId ? { credentialId: response.credentialId } : {}),
            ...(response.publickey ? { publickey: response.publickey, publicKey: response.publickey } : {}),
            ...(response.accountName ? { accountName: response.accountName } : {}),
        }

        // 1. Expo WebView (window.ReactNativeWebView) - PRIORITIZE THIS
        if ((window as any).ReactNativeWebView) {
            // Send data first
            (window as any).ReactNativeWebView.postMessage(JSON.stringify({
                type: response.type,
                data: effectiveData
            }));

            // Then close
            setTimeout(() => {
                (window as any).ReactNativeWebView.postMessage(JSON.stringify({
                    type: "CLOSE_WEBVIEW"
                }));
            }, 1000); // Small delay to ensure data processing
            return;
        }

        // 2. Expo (AuthSession Redirect) OR Standard Redirect
        if ((env === 'expo' && params.expoParam) || params.redirectUrl) {
            const targetUrl = params.expoParam || params.redirectUrl || '';
            if (!targetUrl) return;

            try {
                const url = new URL(targetUrl);
                // Append all response data as query params
                url.searchParams.set('type', response.type);
                if (response.error) {
                    url.searchParams.set('error', response.error);
                    if (response.details) url.searchParams.set('details', response.details);
                } else {
                    url.searchParams.set('success', 'true');

                    // Add effective data to query params
                    if (effectiveData.credentialId) url.searchParams.set('credentialId', effectiveData.credentialId);
                    if (effectiveData.publickey) url.searchParams.set('publicKey', effectiveData.publickey);
                    if (effectiveData.accountName) url.searchParams.set('accountName', effectiveData.accountName);
                    if (effectiveData.normalized) url.searchParams.set('signature', effectiveData.normalized);
                    if (effectiveData.msg) url.searchParams.set('msg', effectiveData.msg);
                    if (effectiveData.clientDataJSONReturn) url.searchParams.set('clientDataJSONReturn', effectiveData.clientDataJSONReturn);
                    if (effectiveData.authenticatorDataReturn) url.searchParams.set('authenticatorDataReturn', effectiveData.authenticatorDataReturn);

                    // Add validation/metadata fields
                    if (effectiveData.timestamp) url.searchParams.set('timestamp', effectiveData.timestamp);
                    if (effectiveData.environment) url.searchParams.set('environment', effectiveData.environment);
                    if (effectiveData.platform) url.searchParams.set('platform', effectiveData.platform);
                    if (effectiveData.expo) url.searchParams.set('expo', effectiveData.expo);

                    // Flatten other data if reasonable or needed
                }

                console.log("Redirecting to:", url.toString());
                window.location.href = url.toString();
            } catch (e) {
                console.error("Failed to construct redirect URL", e);
            }
            return;
        }

        // Construct PostMessage payload matching DialogManager expectation
        // DialogManager expects: { type, data, error }
        const messageData = {
            type: response.type,
            data: effectiveData,
            ...(response.error ? { error: { message: response.error, details: response.details } } : {})
        }

        // 3. Iframe
        if (isIframe()) {
            window.parent.postMessage(messageData, '*')
            return
        }

        // 3. Popup Window
        if (window.opener && window.opener !== window) {
            window.opener.postMessage(messageData, '*')
            window.close() // Usually popups close themselves after success
        }
    }
}
