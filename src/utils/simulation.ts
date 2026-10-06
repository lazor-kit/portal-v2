import {
    Connection,
    VersionedTransaction,
    Transaction,
    LAMPORTS_PER_SOL,
    PublicKey,
    VersionedMessage,
    Message
} from "@solana/web3.js";
import { Buffer } from "buffer";
import type { TokenFacts } from "./preview";

export interface BalanceChange {
    /** The account whose balance changes: a token account's owner when known. */
    account: string;
    token: string;
    /** Signed: "+0.5", "-0.25". */
    amount: string;
}

export interface SimulationResult {
    appName: string;
    balanceChanges: BalanceChange[];
    network: string;
    networkFee: string;
    networkFeeUSD: string;
    autoConfirm: string;
    chainId: string;
    error?: string;
    /** Token accounts (mint, owner) and mint decimals the simulation read; absent when it read nothing. */
    facts?: TokenFacts;
    /** No simulation result at all (the RPC route was unreachable or not configured), as opposed to a failing transaction. */
    unavailable?: boolean;
}


export type Cluster = "mainnet" | "devnet";

/** The portal's own RPC route for `cluster`; it holds the upstream URL and key. */
export function rpcEndpoint(cluster: Cluster): string {
    return new URL(`/api/rpc?cluster=${cluster}`, window.location.origin).href;
}

export function connectionFor(cluster: Cluster): Connection {
    return new Connection(rpcEndpoint(cluster), { commitment: "confirmed", disableRetryOnRateLimit: true });
}

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Helper to parse amount from SPL Token Account data.
 * SPL Token Account Layout:
 *   mint: 32 bytes
 *   owner: 32 bytes
 *   amount: 8 bytes (u64, little endian) => Offset 64
 */
function parseTokenAmount(data: Buffer): bigint {
    if (data.length < 72) return BigInt(0);
    return data.readBigUInt64LE(64);
}

/**
 * Helper to calculate the offset of the message in a transaction buffer.
 * Transaction wire format:
 * [signatures count: compact-u16] [signatures: 64 bytes * count] [message]
 */
function getMessageOffset(buffer: Buffer): number {
    let offset = 0;
    const len = buffer.length;

    // Decode Signatures Count (compact-u16)
    let sigCount = 0;
    let shift = 0;
    while (true) {
        if (offset >= len) return len; // Out of bounds
        const elem = buffer[offset];
        offset++;
        sigCount |= (elem & 0x7f) << shift;
        if ((elem & 0x80) === 0) break;
        shift += 7;
    }

    // Skip Signatures (64 bytes each)
    offset += sigCount * 64;
    return offset;
}

/**
 * Helper to fetch SOL price from CoinGecko
 */
async function getSolPrice(): Promise<number> {
    try {
        const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        if (!response.ok) return 0;
        const data = await response.json();
        return data.solana?.usd || 0;
    } catch (e) {
        console.warn("Failed to fetch SOL price", e);
        return 0;
    }
}

/**
 * Simulates a transaction to determine balance changes and metadata.
 */
export async function simulateTransaction(base64Tx: string, cluster: Cluster): Promise<SimulationResult> {
    const connection = connectionFor(cluster);
    let networkFee = "Unknown";
    let isSuccess = false;
    const balanceChanges: BalanceChange[] = [];

    console.log("Simulating transaction...", { length: base64Tx.length });

    let simulated: any = null;
    let facts: TokenFacts | undefined;
    let transaction: Transaction | VersionedTransaction | null = null;
    let isVersioned = false;

    try {
        const txBuffer = Buffer.from(base64Tx, "base64");

        try {
            const messageOffset = getMessageOffset(txBuffer);

            // Determine version based on the Message Prefix (first byte of message)
            let isVersionedPayload = false;
            // Check if offset is within bounds
            if (messageOffset < txBuffer.length) {
                const messagePrefix = txBuffer[messageOffset];
                // If the most significant bit is set, it's a versioned message
                isVersionedPayload = (messagePrefix & 0x80) !== 0;
            }

            if (isVersionedPayload) {
                transaction = VersionedTransaction.deserialize(txBuffer);
                isVersioned = true;
            } else {
                transaction = Transaction.from(txBuffer);
                isVersioned = false;
            }
        } catch (e) {
            console.warn("Failed to deserialize transaction, trying as Message:", e);
            // Fallback: Try to deserialize as Message (Legacy or Versioned) and wrap in Transaction
            try {
                // Check version bit of message header (byte 0)
                const isVersionedMessage = (txBuffer[0] & 0x80) !== 0;

                if (isVersionedMessage) {
                    const message = VersionedMessage.deserialize(txBuffer);
                    // Create dummy signatures
                    const signatures = new Array(message.header.numRequiredSignatures).fill(new Uint8Array(64).fill(0));
                    transaction = new VersionedTransaction(message, signatures);
                    isVersioned = true;
                } else {
                    const message = Message.from(txBuffer);
                    // Create dummy signatures
                    const signatures = new Array(message.header.numRequiredSignatures).fill("1111111111111111111111111111111111111111111111111111111111111111");
                    transaction = Transaction.populate(message, signatures);
                    isVersioned = false;
                }
            } catch (msgError) {
                console.error("Failed to deserialize as Message too:", msgError);
                throw msgError; // Throw original error
            }
        }

        if (!transaction) throw new Error("Could not deserialize transaction");

        // 1. Identify all relevant accounts to track
        let allKeys: PublicKey[] = [];

        if (isVersioned) {
            const vTx = transaction as VersionedTransaction;
            allKeys = vTx.message.staticAccountKeys;
        } else {
            const lTx = transaction as Transaction;
            // compileMessage might fail if signatures are missing/dummy? No, should be fine.
            allKeys = lTx.compileMessage().accountKeys;
        }

        // Deduplicate keys
        const uniqueKeys = allKeys.reduce((acc, key) => {
            if (!acc.find(k => k.equals(key))) acc.push(key);
            return acc;
        }, [] as PublicKey[]);

        // 2. Fetch Pre-Simulation State
        const preAccountInfos = await connection.getMultipleAccountsInfo(uniqueKeys);

        // Map Key -> Pre-State
        const preStates = new Map<string, { lamports: number, data: Buffer, owner: PublicKey }>();
        uniqueKeys.forEach((key, index) => {
            const info = preAccountInfos[index];
            if (info) {
                preStates.set(key.toBase58(), {
                    lamports: info.lamports,
                    data: info.data,
                    owner: info.owner
                });
            } else {
                // Account doesn't exist yet (0 balance)
                preStates.set(key.toBase58(), {
                    lamports: 0,
                    data: Buffer.alloc(0),
                    owner: PublicKey.default
                });
            }
        });

        // 3. Simulate with 'accounts' config to get Post-Simulation State
        const config: any = {
            replaceRecentBlockhash: true,
            commitment: "confirmed",
            accounts: {
                encoding: "base64",
                addresses: uniqueKeys.map(k => k.toBase58())
            }
        };

        if (isVersioned) {
            const response = await connection.simulateTransaction(transaction as VersionedTransaction, config);
            simulated = response.value;
        } else {
            const legacyTx = transaction as Transaction;
            simulated = (await connection.simulateTransaction(legacyTx, undefined, uniqueKeys)).value;
        }

        if (simulated.err) {
            console.error("Simulation error:", simulated.err);
        } else {
            isSuccess = true;
            if (simulated.unitsConsumed) {
                // Estimate Fee
                let numSigs = 0;
                if (isVersioned) {
                    numSigs = (transaction as VersionedTransaction).signatures.length;
                } else {
                    numSigs = (transaction as Transaction).signatures.length;
                }
                const feeInSol = numSigs * 0.000005;
                networkFee = `${feeInSol.toFixed(6)} SOL`;
            }
        }

        // Identify Fee Payer / Main User
        let payerKey: PublicKey | null = null;

        // 3b. Fetch Mint Info for Decimals (Universal SPL Support)
        const mintsToFetch = new Set<string>();
        // Check Pre-States for Token Accounts
        preStates.forEach((info) => {
            if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
                if (info.data.length >= 32) {
                    const mint = new PublicKey(info.data.slice(0, 32)).toBase58();
                    mintsToFetch.add(mint);
                }
            }
        });

        const mintDecimals = new Map<string, number>();
        // Add known USDC
        mintDecimals.set("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6);

        if (mintsToFetch.size > 0) {
            const mintKeys = Array.from(mintsToFetch).map(s => new PublicKey(s));
            // batch fetch in chunks of 100 if needed (rarely needed for single tx)
            const mintInfos = await connection.getMultipleAccountsInfo(mintKeys);
            mintInfos.forEach((info, i) => {
                if (info) {
                    // Mint Layout: [..., decimals(1), ...] at offset 44
                    if (info.data.length >= 45) {
                        const decimals = info.data.readUInt8(44);
                        mintDecimals.set(mintKeys[i].toBase58(), decimals);
                    }
                }
            });
        }

        console.log("Fetched Mint Decimals:", mintDecimals);

        // Helper to format amount with decimals
        const formatTokenAmount = (amount: bigint, mint: string): string => {
            const decimals = mintDecimals.get(mint) ?? 0;

            // If decimals are 0, just format the BigInt with commas
            if (decimals === 0) {
                return amount.toLocaleString('en-US');
            }

            const divisor = BigInt(10 ** decimals);
            const integerPart = amount / divisor;
            const fractionalPart = amount % divisor;

            const integerStr = integerPart.toLocaleString('en-US');

            if (fractionalPart === BigInt(0)) {
                return integerStr;
            }

            let fracStr = fractionalPart.toString().padStart(decimals, '0');
            fracStr = fracStr.replace(/0+$/, ''); // Trim trailing zeros

            return `${integerStr}.${fracStr}`;
        };

        const formatSOL = (solAmount: number): string => {
            // Max 9 decimals for SOL, but trim trailing zeros
            // Use Intl for separators if number is large enough (though mostly small for fees/transfers)
            return new Intl.NumberFormat('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 9,
            }).format(solAmount);
        };

        if (transaction instanceof VersionedTransaction) {
            // For versioned, the first signer is payer usually, or staticAccountKeys[0] if signed.
            // The message header numRequiredSignatures > 0 means keys[0] is signer.
            payerKey = (transaction as VersionedTransaction).message.staticAccountKeys[0];
        } else {
            const lTx = transaction as Transaction;
            if (lTx.feePayer) payerKey = lTx.feePayer;
            else if (lTx.instructions.length > 0 && lTx.instructions[0].keys.length > 0) {
                // best guess
                payerKey = lTx.instructions[0].keys.find(k => k.isSigner)?.pubkey || lTx.instructions[0].keys[0].pubkey;
            }
        }

        // 4. Calculate Balance Changes (Post - Pre)
        if (simulated && simulated.accounts) {
            simulated.accounts.forEach((postAccount: any, index: number) => {
                if (index >= uniqueKeys.length) return;
                const key = uniqueKeys[index];
                const keyStr = key.toBase58();
                const preState = preStates.get(keyStr);

                if (!preState) return;

                // ... (SOL and Token logic) ...
                let postLamports = 0;
                let postData = Buffer.alloc(0);
                let postOwner = PublicKey.default;

                if (postAccount) {
                    postLamports = postAccount.lamports;
                    if (Array.isArray(postAccount.data)) {
                        postData = Buffer.from(postAccount.data[0], "base64");
                    } else if (typeof postAccount.data === "string") {
                        postData = Buffer.from(postAccount.data, "base64");
                    }
                    postOwner = new PublicKey(postAccount.owner);
                }

                const diffLamports = postLamports - preState.lamports;
                if (diffLamports !== 0) {
                    // Check if this is User's Account (Payer)
                    const isUser = payerKey && key.equals(payerKey);

                    const diffSol = diffLamports / LAMPORTS_PER_SOL;
                    const sign = diffLamports > 0 ? "+" : "-";

                    // Only show significant changes or if it's the user
                    if (Math.abs(diffSol) > 0.000000001 || isUser) {
                        balanceChanges.push({
                            account: keyStr,
                            token: "SOL",
                            amount: `${sign}${formatSOL(Math.abs(diffSol))}`,
                        });
                    }
                }

                const isPreToken = preState.owner.equals(TOKEN_PROGRAM_ID) || preState.owner.equals(TOKEN_2022_PROGRAM_ID);
                const isPostToken = postOwner.equals(TOKEN_PROGRAM_ID) || postOwner.equals(TOKEN_2022_PROGRAM_ID);

                if (isPreToken || isPostToken) {
                    const preAmount = parseTokenAmount(preState.data);
                    const postAmount = parseTokenAmount(postData);
                    const diffAmount = postAmount - preAmount;

                    if (diffAmount !== BigInt(0)) {
                        const sign = diffAmount > BigInt(0) ? "+" : "-";

                        let mintStr = "Unknown Token";
                        let mintKey: PublicKey | null = null;
                        let ownerKey: PublicKey | null = null;

                        // Extract Mint and Owner from Account Data
                        if (postData.length >= 64) {
                            mintKey = new PublicKey(postData.slice(0, 32));
                            ownerKey = new PublicKey(postData.slice(32, 64));
                        } else if (preState.data.length >= 64) {
                            mintKey = new PublicKey(preState.data.slice(0, 32));
                            ownerKey = new PublicKey(preState.data.slice(32, 64));
                        }

                        if (mintKey) {
                            mintStr = mintKey.toBase58();
                        }

                        // Clean up Mint Names for display
                        let displayName = mintStr.slice(0, 4) + "..." + mintStr.slice(-4);
                        if (mintStr === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") displayName = "USDC";
                        if (mintStr === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") displayName = "USDT";
                        if (mintStr === "So11111111111111111111111111111111111111112") displayName = "WSOL";

                        // We want to show meaningful changes.
                        const formattedAmount = formatTokenAmount(diffAmount > BigInt(0) ? diffAmount : -diffAmount, mintStr);
                        const isRaw = !mintDecimals.has(mintStr) && mintStr !== "SOL";

                        balanceChanges.push({
                            account: ownerKey ? ownerKey.toBase58() : keyStr,
                            token: displayName, // Just the name (e.g. USDC)
                            amount: `${sign}${formattedAmount}${isRaw ? ' (raw units)' : ''}`,
                        });
                    }
                }
            });
        }

        // Token accounts and mints the preview touches, for the summary (utils/preview).
        const accounts: Record<string, { mint: string; owner: string }> = {};
        const record = (key: string, data: Buffer, owner: PublicKey) => {
            if ((owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) && data.length >= 64 && !accounts[key]) {
                accounts[key] = { mint: new PublicKey(data.slice(0, 32)).toBase58(), owner: new PublicKey(data.slice(32, 64)).toBase58() };
            }
        };
        preStates.forEach((info, key) => record(key, info.data, info.owner));
        if (simulated && Array.isArray(simulated.accounts)) {
            simulated.accounts.forEach((post: any, index: number) => {
                if (!post || index >= uniqueKeys.length) return;
                const data = Array.isArray(post.data) ? Buffer.from(post.data[0], "base64") : typeof post.data === "string" ? Buffer.from(post.data, "base64") : Buffer.alloc(0);
                record(uniqueKeys[index].toBase58(), data, new PublicKey(post.owner));
            });
        }
        facts = { accounts, decimals: Object.fromEntries(mintDecimals) };

    } catch (error) {
        console.warn("Simulation unavailable:", error instanceof Error ? error.message : error);
    }

    let errorMsg: string | undefined;

    if (!isSuccess) {
        if (typeof simulated?.err === 'object' && simulated.err !== null) {
            const keys = Object.keys(simulated.err);
            if (keys.length > 0) {
                const errorType = keys[0];
                const errorData = simulated.err[errorType];
                if (errorType === 'InstructionError' && Array.isArray(errorData)) {
                    errorMsg = `Transaction simulation failed: Instruction Error at index ${errorData[0]} - ${JSON.stringify(errorData[1])}`;
                } else if (errorType === 'InsufficientFundsForRent') {
                    errorMsg = "Transaction simulation failed: Insufficient funds for rent";
                } else {
                    errorMsg = `Transaction simulation failed: ${errorType} - ${JSON.stringify(errorData)}`;
                }
            } else {
                errorMsg = "Transaction simulation failed with unknown error";
            }
        } else if (simulated?.err) {
            errorMsg = `Transaction simulation failed: ${String(simulated.err)}`;
        } else {
            errorMsg = simulated ? "Transaction simulation failed" : "This transaction could not be simulated.";
        }
        if (errorMsg) {
            errorMsg = errorMsg.replace(/"/g, '');
        }
    }

    let networkFeeUSD = "$0.00";
    if (cluster === 'mainnet') {
        // Calculate fee in USD
        const feeInSol = parseFloat(networkFee.split(' ')[0]);
        if (!isNaN(feeInSol) && feeInSol > 0) {
            const price = await getSolPrice();
            if (price > 0) {
                const feeUSD = feeInSol * price;
                networkFeeUSD = feeUSD < 0.01 ? "<$0.01" : `~$${feeUSD.toFixed(2)}`;
            } else {
                networkFeeUSD = "~$0.01"; // Fallback if price fetch fails
            }
        } else {
            networkFeeUSD = "Unknown";
        }
    }

    return {
        appName: "Application",
        balanceChanges: balanceChanges.length > 0 ? balanceChanges : [],
        network: cluster === 'mainnet' ? "Solana Mainnet" : "Solana Devnet",
        networkFee,
        networkFeeUSD,
        autoConfirm: "Off",
        chainId: cluster === 'mainnet' ? "mainnet-beta" : "devnet",
        error: errorMsg,
        facts,
        unavailable: !isSuccess && !simulated,
    };
}
