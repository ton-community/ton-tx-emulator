import {Transaction, fromNano} from "@ton/core";
import {Address, ExternalAddress} from "@ton/core"

 // Helper function to get the mapped address to human readable format, fallback to original address if not found
 export type AddressMapFunc = (address: Address | ExternalAddress | null | undefined) => string | null | undefined;

/**
 * @param tx Transaction to create log string
 * @param mapFunc Optional function to map addresses to human-readable strings
 * @returns Transaction log string
 */
export function prettyLogTransaction(tx: Transaction, mapFunc?: AddressMapFunc) {
    // Helper to map addresses using mapFunc and fallback to original if mapping is false or undefined
    const mapAddress = (address: Address | ExternalAddress | null | undefined) => {
        return mapFunc ? (mapFunc(address) || address) : address;
    };

    // Map the source and destination addresses for the inMessage
    let res = `${mapAddress(tx.inMessage?.info.src!)}  ➡️  ${mapAddress(tx.inMessage?.info.dest!)}\n`;

    for (let message of tx.outMessages.values()) {
        const dest = mapAddress(message.info.dest);
        if (message.info.type === 'internal') {
            res += `     ➡️  ${fromNano(message.info.value.coins)} 💎 ${dest}\n`;
        } else {
            res += `      ➡️  ${dest}\n`;
        }
    }

    return res;
}

/**
 * Log transactions using `console.log`. Logs are generated based on the result of {@link prettyLogTransaction}.
 * 
 * Example output without address mapping:
 * ```
 * null  ➡️  EQBGhqLAZseEqRXz4ByFPTGV7SVMlI4hrbs-Sps_Xzx01x8G
 *       ➡️  0.05 💎 EQC2VluVfpj2FoHNMAiDMpcMzwvjLZxxTG8ecq477RE3NvVt
 * ```
 * 
 * Example output with address mapping:
 * ```
 * null  ➡️  Torch's Wallet
 *       ➡️  0.05 💎 Alan's Wallet
 * ```
 * 
 * @param txs Transactions to log
 * @param mapFunc Optional function to map address to a human-readable format. If provided, addresses will be mapped; otherwise, raw addresses will be displayed.
 */
export function prettyLogTransactions(txs: Transaction[], mapFunc?: AddressMapFunc) {

    let out = ''

    for (let tx of txs) {
        out += prettyLogTransaction(tx, mapFunc) + '\n\n'
    }

    console.log(out)
}
