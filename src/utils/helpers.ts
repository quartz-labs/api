import { BN, DRIFT_PROGRAM_ID, PublicKey } from "@drift-labs/sdk";
import { Logger } from "winston";
import { QUARTZ_PROGRAM_ID, QUARTZ_HEALTH_BUFFER_PERCENTAGE } from "../config/constants.js";
import config from "../config/config.js";

export function bnToDecimal(bn: BN, decimalPlaces: number): number {
    const decimalFactor = Math.pow(10, decimalPlaces);
    return bn.toNumber() / decimalFactor;
}

export const getVault = (owner: PublicKey) => {
    const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.toBuffer()],
        QUARTZ_PROGRAM_ID
    )
    return vault;
}
  
export const getDriftUser = (user: PublicKey) => {
    const authority = getVault(user);
    const [userPda] = PublicKey.findProgramAddressSync(
        [
			Buffer.from("user"),
			authority.toBuffer(),
			new BN(0).toArrayLike(Buffer, 'le', 2),
		],
		new PublicKey(DRIFT_PROGRAM_ID)
    );
    return userPda;
}

export const getQuartzHealth = (driftHealth: number): number => {
    if (driftHealth <= 0) return 0;
    if (driftHealth >= 100) return 100;

    return Math.floor(
        Math.min(
            100,
            Math.max(
                0,
                (driftHealth - QUARTZ_HEALTH_BUFFER_PERCENTAGE) / (1 - (QUARTZ_HEALTH_BUFFER_PERCENTAGE / 100))
            )
        )
    );
}

export const retryRPCWithBackoff = async <T>(
    fn: () => Promise<T>,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            if (error?.message?.includes('503')) {
                const delay = initialDelay * Math.pow(2, i);
                if (logger) logger.warn(`RPC node unavailable, retrying in ${delay}ms...`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

export const getGoogleAccessToken = async () => {
    const jwtToken = JSON.stringify({
        iss: config.GOOGLE_CLIENT_EMAIL,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
    });

    const signedJwt = await signJwt(jwtToken, config.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"));
    
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: signedJwt,
        }),
    });

    const data = await response.json();
    return data.access_token;
}

const signJwt = async (token: string, privateKey: string): Promise<string> => {
    const encoder = new TextEncoder();
    const header = { alg: 'RS256', typ: 'JWT' };
    
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(token).toString('base64url');
    const signInput = `${encodedHeader}.${encodedPayload}`;

    const pemContents = privateKey
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\n/g, '');
    const pemArrayBuffer = new Uint8Array(Buffer.from(pemContents, 'base64')).buffer;

    const key = await crypto.subtle.importKey(
        'pkcs8',
        pemArrayBuffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key,
        encoder.encode(signInput)
    );

    const encodedSignature = Buffer.from(signature).toString('base64url');
    return `${signInput}.${encodedSignature}`;
}

export const getTimestamp = () => {
    const date = new Date();
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}
