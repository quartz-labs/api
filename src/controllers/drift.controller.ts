import config from "../config/config.js";
import type { NextFunction, Request, Response } from "express";
import { bnToDecimal } from "../utils/helpers.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { HttpException } from "../utils/errors.js";
import { QuartzClient, type QuartzUser, SUPPORTED_DRIFT_MARKETS, type BN } from "@quartz-labs/sdk";

export class DriftController {
    private quartzClientPromise: Promise<QuartzClient>;

    private rateCache: Record<string, { depositRate: number; borrowRate: number; timestamp: number }> = {};
    private RATE_CACHE_DURATION = 60_000;

    constructor() {
        const connection = new Connection(config.RPC_URL);
        this.quartzClientPromise = QuartzClient.fetchClient(connection);
    }

    private validateAddress(address: string): PublicKey {
        try {
            const pubkey = new PublicKey(address);
            return pubkey;
        } catch {
            throw new HttpException(400, "Invalid address");
        }
    }

    private async getQuartzUser(pubkey: PublicKey): Promise<QuartzUser> {
        try {
            const quartzClient = await this.quartzClientPromise;
            return quartzClient.getQuartzAccount(pubkey);
        } catch {
            throw new HttpException(400, "Quartz account not found");
        }
    }

    private validateMarketIndices(marketIndicesParam: string) {
        if (!marketIndicesParam) {
            throw new HttpException(400, "Market indices are required");
        }

        const decodedMarketIndices = decodeURIComponent(marketIndicesParam);
        const marketIndices = decodedMarketIndices.split(',').map(Number).filter(n => !Number.isNaN(n));
        if (marketIndices.length === 0) {
            throw new HttpException(400, "Invalid market indices");
        }

        if (marketIndices.some(index => !SUPPORTED_DRIFT_MARKETS.includes(index as any))) {
            throw new HttpException(400, "Unsupported market index");
        }

        return marketIndices;
    }

    public getRate = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const quartzClient = await this.quartzClientPromise;

            const marketIndices = this.validateMarketIndices(req.query.marketIndices as string);

            const now = Date.now();
            const uncachedMarketIndices = marketIndices.filter(index => {
                const cached = this.rateCache[index];
                return !cached || (now - cached.timestamp) > this.RATE_CACHE_DURATION;
            });

            if (uncachedMarketIndices.length > 0) {
                const promises = uncachedMarketIndices.map(async (index) => {
                    let depositRateBN: BN;
                    let borrowRateBN: BN;
                    try {
                        depositRateBN = await quartzClient.getDepositRate(index);
                        borrowRateBN = await quartzClient.getBorrowRate(index);
                    } catch {
                        throw new HttpException(400, `Could not find rates for spot market index ${index}`);
                    }
                
                    // Update cache
                    this.rateCache[index] = {
                        depositRate: bnToDecimal(depositRateBN, 6),
                        borrowRate: bnToDecimal(borrowRateBN, 6),
                        timestamp: now
                    };
                });
    
                await Promise.all(promises);
            }

            const rates = marketIndices.map(index => ({
                depositRate: this.rateCache[index]?.depositRate,
                borrowRate: this.rateCache[index]?.borrowRate
            }));

            res.status(200).json(rates);
        } catch (error) {
            next(error);
        }
    }

    public getBalance = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const marketIndices = this.validateMarketIndices(req.query.marketIndices as string);
            const address = this.validateAddress(req.query.address as string);
            const user = await this.getQuartzUser(address).catch(() => {
                throw new HttpException(400, "Address is not a Quartz user");
            });

            const balances = await Promise.all(
                marketIndices.map(index => user.getTokenBalance(index))
            );

            res.status(200).json(balances);
        } catch (error) {
            next(error);
        }
    }

    public getWithdrawLimit = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const marketIndices = this.validateMarketIndices(req.query.marketIndices as string);
            const address = this.validateAddress(req.query.address as string);
            const user = await this.getQuartzUser(address).catch(() => {
                throw new HttpException(400, "Address is not a Quartz user");
            });

            const withdrawLimits = await Promise.all(
                marketIndices.map(index => user.getWithdrawalLimit(index))
            );

            res.status(200).json(withdrawLimits);
        } catch (error) {
            next(error);
        }
    }

    public getHealth = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const address = this.validateAddress(req.query.address as string);
            const user = await this.getQuartzUser(address).catch(() => {
                throw new HttpException(400, "Address is not a Quartz user");
            });
            const health = user.getHealth();
            res.status(200).json(health);
        } catch (error) {
            next(error);
        }
    }
}