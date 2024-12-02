import { NextFunction, Request, Response } from "express";
import { HttpException } from "../utils/errors.js";
import { AnchorProvider, Idl, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import config from "../config/config.js";
import quartzIdl from "../idl/quartz.json" with { type: "json" };
import { Quartz } from "../types/quartz.js";
import { BASE_UNITS_PER_USDC, QUARTZ_PROGRAM_ID, SUPPORTED_DRIFT_MARKETS } from "../config/constants.js";
import { getDriftUser, retryRPCWithBackoff } from "../utils/helpers.js";
import { DriftUser } from "../model/driftUser.js";
import { DriftClient, fetchUserAccountsUsingKeys, UserAccount } from "@drift-labs/sdk";
import { DriftClientService } from "../services/driftClientService.js";

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
}