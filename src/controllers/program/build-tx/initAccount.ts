import { PublicKey } from '@solana/web3.js';
import { QuartzClient } from '@quartz-labs/sdk';
import { connection, quartzClient } from '../../../index.js';
import { buildTransaction } from '../../../utils/helpers.js';
import { DEFAULT_CARD_TRANSACTION_LIMIT, DEFAULT_CARD_TIMEFRAME, DEFAULT_CARD_TIMEFRAME_LIMIT, DEFAULT_CARD_TIMEFRAME_RESET } from '../../../config/constants.js';


export const buildInitAccountTransaction = async (
    address: PublicKey,
): Promise<string> => {
    const client = quartzClient || await QuartzClient.fetchClient(connection);

    const {
        ixs,
        lookupTables,
        signers
    } = await client.makeInitQuartzUserIxs(
        address,
        DEFAULT_CARD_TRANSACTION_LIMIT,
        DEFAULT_CARD_TIMEFRAME_LIMIT,
        DEFAULT_CARD_TIMEFRAME,
        DEFAULT_CARD_TIMEFRAME_RESET
    );

    const transaction = await buildTransaction(connection, ixs, address, lookupTables);
    transaction.sign(signers);

    return Buffer.from(transaction.serialize()).toString("base64");
}