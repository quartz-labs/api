import type { NextFunction, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { HttpException } from '../../utils/errors.js';
import { AccountStatus } from '../../types/enums/AccountStatus.enum.js';
import { getCardDetailsFromInternalApi } from './program-data/cardDetails.js';
import { Controller } from '../../types/controller.class.js';
import { checkHasVaultHistory, checkIsMissingBetaKey, checkIsVaultInitialized, checkRequiresUpgrade } from './program-data/accountStatus.js';
import { getDepositLimits } from './program-data/depositLimit.js';

export class ProgramDataController extends Controller {
    constructor() {
        super();
    }

    public getAccountStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const address = req.query.wallet as string;
            if (!address) {
                throw new HttpException(400, "Wallet address is required");
            }

            let pubkey;
            try {
                pubkey = new PublicKey(address);
            } catch {
                throw new HttpException(400, "Invalid wallet address");
            }

            const [hasVaultHistory, isMissingBetaKey, isVaultInitialized, requiresUpgrade] = await Promise.all([
                checkHasVaultHistory(pubkey),
                checkIsMissingBetaKey(pubkey),
                checkIsVaultInitialized(pubkey),
                checkRequiresUpgrade(pubkey)
            ]);
            
            if (!isVaultInitialized && hasVaultHistory) {
                res.status(200).json({ status: AccountStatus.CLOSED });
                return;
            } else if (isMissingBetaKey) {
                res.status(200).json({ status: AccountStatus.NO_BETA_KEY });
                return;
            } else if (isVaultInitialized) {
                if (requiresUpgrade) {
                    res.status(200).json({ status: AccountStatus.UPGRADE_REQUIRED });
                    return;
                } else {
                    res.status(200).json({ status: AccountStatus.INITIALIZED });
                    return;
                }
            } else {
                res.status(200).json({ status: AccountStatus.NOT_INITIALIZED });
                return;
            }
        } catch (error) {
            next(error);
        }
    }

    public getCardDetails = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const id = req.body.id as string;
            if (!id) {
                throw new HttpException(400, "Card ID is required");
            }

            const jwtToken = req.body.jwtToken as string;
            if (!jwtToken) {
                throw new HttpException(400, "JWT token is required");
            }

            const cardDetails = await getCardDetailsFromInternalApi(id, jwtToken);

            res.status(200).json(cardDetails);
            return;
        } catch (error) {
            this.getLogger().error(`Error confirming transaction: ${error}`);
            next(error);
        }
    }

    public getDepositLimits = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const address = new PublicKey(req.body.address as string);
            if (!address) {
                throw new HttpException(400, "Wallet address is required");
            }

            const depositLimits = await getDepositLimits(address);

            res.status(200).json(depositLimits);
            return;
        } catch (error) {
            this.getLogger().error(`Error confirming transaction: ${error}`);
            next(error);
        }
    }

}