import { NextFunction, Request, Response } from "express";
import { HttpException } from "../utils/errors.js";
import { AnchorProvider, Idl, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import config from "../config/config.js";
import quartzIdl from "../idl/quartz.json" with { type: "json" };
import { Quartz } from "../types/quartz.js";
import { BASE_UNITS_PER_USDC, DRIFT_MARKET_INDEX_USDC, QUARTZ_PROGRAM_ID, SUPPORTED_DRIFT_MARKETS, YIELD_CUT } from "../config/constants.js";
import { bnToDecimal, getDriftUser, getGoogleAccessToken, getTimestamp, retryRPCWithBackoff } from "../utils/helpers.js";
import { DriftUser } from "../model/driftUser.js";
import { calculateDepositRate, DriftClient, fetchUserAccountsUsingKeys, UserAccount } from "@drift-labs/sdk";
import { DriftClientService } from "../services/driftClientService.js";
import { WebflowClient } from "webflow-api";
import { DriftController } from "./drift.controller.js";

export class DataController {
    private connection: Connection;
    private program: Program<Quartz>;
    private driftClientPromise: Promise<DriftClient>;

    private priceCache: Record<string, { price: number; timestamp: number }> = {};
    private PRICE_CACHE_DURATION = 60_000;

    constructor() {
        this.connection = new Connection(config.RPC_URL);
        const wallet = new Wallet(Keypair.generate());

        const provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
        setProvider(provider);
        this.program = new Program(quartzIdl as Idl, QUARTZ_PROGRAM_ID, provider) as unknown as Program<Quartz>;

        this.driftClientPromise = DriftClientService.getDriftClient();
    }

    public getPrice = async (req: Request, res: Response, next: NextFunction) => {
        const ids = req.query.ids as string;

        if (!ids) return next(new HttpException(400, "ID is required"));
        const decodedIds = decodeURIComponent(ids);
        const idArray = decodedIds.split(",");
        
        try {
            const now = Date.now();
            const uncachedIds = idArray.filter(id => {
                const cached = this.priceCache[id];
                return !cached || (now - cached.timestamp) > this.PRICE_CACHE_DURATION;
            });

            if (uncachedIds.length > 0) {
                const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${uncachedIds.join(',')}&vs_currencies=usd`);

                if (!response.ok) {
                    return next(new HttpException(400, "Failed to fetch data from CoinGecko"));
                }

                const data = await response.json();

                Object.keys(data).forEach(id => {
                    this.priceCache[id] = {
                        price: data[id].usd,
                        timestamp: now
                    };
                });
            }

            const pricesUsd = idArray.reduce((acc, id) => {
                if (this.priceCache[id]) {
                    acc[id] = this.priceCache[id].price;
                }
                return acc;
            }, {} as Record<string, number>);

            if (Object.keys(pricesUsd).length === 0) {
                return next(new HttpException(400, "Invalid ID"));
            }

            res.status(200).json(pricesUsd);
        } catch (error) {
            next(error);
        }
    }

    public getUsers = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const vaults = await retryRPCWithBackoff(
                async () => {
                    return await this.program.account.vault.all();
                },
                3,
                1_000
            );

            const users = vaults.map(vault => vault.account.owner.toBase58());

            res.status(200).json({
                count: users.length,
                users: users
            });
        } catch (error) {
            next(error);
        }
    }

    public getTVL = async (req: Request, res: Response, next: NextFunction) => {
        const driftClient = await this.driftClientPromise;

        try {
            const [vaults, driftUsers] = await retryRPCWithBackoff(
                async () => {
                    const vaults = await this.program.account.vault.all();
                    const driftUsers = await fetchUserAccountsUsingKeys(
                        this.connection, 
                        driftClient.program, 
                        vaults.map((vault) => getDriftUser(vault.account.owner))
                    );
                    const undefinedIndex = driftUsers.findIndex(user => !user);
                    if (undefinedIndex !== -1) {
                        throw new Error(`Failed to fetch drift user for vault ${vaults[undefinedIndex].publicKey.toString()}`);
                    }
                    return [
                        vaults,
                        driftUsers as UserAccount[]
                    ]
                },
                3,
                1_000
            );

            let totalCollateralInUsdc = 0;
            let totalLoansInUsdc = 0;
            for (let i = 0; i < vaults.length; i++) {
                const driftUser = new DriftUser(vaults[i].account.owner, this.connection, driftClient, driftUsers[i]);
                totalCollateralInUsdc += driftUser.getTotalCollateralValue().toNumber();
                totalLoansInUsdc += driftUser.getTotalLiabilityValue().toNumber();
            }

            const baseUnitsToUsd = (baseUnits: number) => Number((baseUnits / BASE_UNITS_PER_USDC).toFixed(2));

            res.status(200).json({
                collateral: baseUnitsToUsd(totalCollateralInUsdc),
                loans: baseUnitsToUsd(totalLoansInUsdc),
                net: baseUnitsToUsd(totalCollateralInUsdc - totalLoansInUsdc)
            });
        } catch (error) {
            next(error);
        }
    }

    public addWaitlist = async (req: Request, res: Response, next: NextFunction) => {
        const email = req.body.email as string;
        if (!email) return next(new HttpException(400, "Email is required"));
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return next(new HttpException(400, "Invalid email"));

        const name = req.body.name as string;
        if (!name) return next(new HttpException(400, "Name is required"));

        const country = req.body.country as string;
        if (!country) return next(new HttpException(400, "Country is required"));

        const newsletter = req.body.newsletter;
        if (newsletter === undefined || newsletter === null) {
            return next(new HttpException(400, "Newsletter is required"));
        }
        if (typeof newsletter !== "boolean") return next(new HttpException(400, "Newsletter must be a boolean"));

        try {
            const accessToken = await getGoogleAccessToken();
            
            // Ensure waitlist is not already present
            const checkResponse = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${config.GOOGLE_SPREADSHEET_ID}/values/waitlist!B:B`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                    }
                }
            );
            if (!checkResponse.ok) throw new Error('Failed to find spreadsheet');
            const data = await checkResponse.json();
            const rows = data.values?.slice(1);
    
            if (!rows || rows.length === 0) throw new Error("Failed to fetch data from spreadsheet");
            if (rows.some((row: string[]) => row[0] === email)) {
                res.status(200).json({ message: "Email already exists in waitlist" });
                return;
            }

            // Append to waitlist
            const appendResponse = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${config.GOOGLE_SPREADSHEET_ID}/values/waitlist!A:F:append?valueInputOption=USER_ENTERED`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        values: [[getTimestamp(), email, name, country, newsletter ? "TRUE" : "FALSE", "1"]]
                    })
                }
            );
            if (!appendResponse.ok) throw new Error('Failed to update spreadsheet');

            // Update Webflow waitlist count
            const newWaitlistCount = rows.length + 1;
            const webflowClient = new WebflowClient({ accessToken: config.WEBFLOW_ACCESS_TOKEN });
            await webflowClient.collections.items.updateItemLive("67504dd7fde047775f88c371", "67504dd7fde047775f88c3aa", {
                id: "67504dd7fde047775f88c3aa",
                fieldData: {
                    name: "Waitlist",
                    slug: "waitlist",
                    count: newWaitlistCount
                }
            });
            
            // Send welcome email through Brevo
            await fetch("https://api.brevo.com/v3/smtp/email", {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    'api-key': config.BREVO_API_KEY
                },
                body: JSON.stringify({
                    templateId: 3,
                    to: [{ email, name }],
                    params: {
                        "NAME": name
                    }
                })
            });

            res.status(200).json({ message: "Email added to waitlist" });
        } catch (error) {
            next(error);
        }
    }

    public updateWebsiteData = async (req: Request, res: Response, next: NextFunction) => {
        const driftClient = await this.driftClientPromise;
        const usdLost = 8592500000;
        const assetsLost = {
            "bitcoin": 1226903,
            "litecoin": 56733,
            "nem": 9000000,
            "nano": 17000000,
            "ripple": 48100000,
            "eos": 3000000,
            "ethereum": 11543,
            "cardano": 2500000,
            "tether": 20800000
        };

        try {   
            const webflowClient = new WebflowClient({ accessToken: config.WEBFLOW_ACCESS_TOKEN });

            // Get USDC deposit rate
            const usdcSpotMarket = await driftClient.getSpotMarketAccount(DRIFT_MARKET_INDEX_USDC);
            if (!usdcSpotMarket) throw new HttpException(400, "Failed to fetch spot market");

            const depositRateBN = calculateDepositRate(usdcSpotMarket);
            const depositRate = bnToDecimal(depositRateBN, 6);
            if (depositRate <= 0) throw new Error("Invalid rate fetched");

            const apyAfterCut = 100 * depositRate * (1 - YIELD_CUT);
            const apyAfterCutRounded = Math.round((apyAfterCut + Number.EPSILON) * 100) / 100;

            // Update USDC deposit rate
            await webflowClient.collections.items.updateItemLive("67504dd7fde047775f88c371", "67504dd7fde047775f88c3be", {
                id: "67504dd7fde047775f88c3be",
                fieldData: {
                    name: "Yield",
                    slug: "yield",
                    count: apyAfterCutRounded
                }
            });

            // Get funds lost to custodians
            const ids = Object.keys(assetsLost).join(',');
            const mockReq = { query: { ids } } as unknown as Request;
            let prices: Record<string, number> = {};
            await new Promise<void>((resolve) => {
                const mockRes = {
                    status: () => ({
                        json: (data: Record<string, number>) => {
                            prices = data;
                            resolve();
                        }
                    })
                } as unknown as Response;
                this.getPrice(mockReq, mockRes, next);
            });

            let totalValueLost = usdLost;
            for (const [coin, amount] of Object.entries(assetsLost)) {
                const price = prices[coin];
                const value = price * amount;
                totalValueLost += value;
            }
            const totalValueLostBillions = Math.trunc(totalValueLost / 1_000_000_000);

            // Update funds lost to custodians
            await webflowClient.collections.items.updateItemLive("67504dd7fde047775f88c371", "67504dd7fde047775f88c3d0", {
                id: "67504dd7fde047775f88c3d0",
                fieldData: {
                    name: "Value Lost",
                    slug: "value-lost",
                    count: totalValueLostBillions
                }
            });

            res.status(200).json({ yield: apyAfterCutRounded, valueLost: totalValueLostBillions });
        } catch (error) {
            next(error);
        }
    }
}
