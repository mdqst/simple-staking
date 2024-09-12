import {
  Phase1Staking,
  PsbtTransactionResult,
} from "@babylonlabs-io/btc-staking-ts";
import { Transaction, networks } from "bitcoinjs-lib";

import { getGlobalParams } from "@/app/api/getGlobalParams";
import { SignPsbtTransaction } from "@/app/common/utils/psbt";
import { Delegation as DelegationInterface } from "@/app/types/delegations";
import { getCurrentGlobalParamsVersion } from "@/utils/globalParams";

import { getFeeRateFromMempool } from "../getFeeRateFromMempool";
import { Fees } from "../wallet/wallet_provider";

import { txFeeSafetyCheck } from "./fee";

// Sign a withdrawal transaction
// Returns:
// - withdrawalTx: the signed withdrawal transaction
// - delegation: the initial delegation
export const signWithdrawalTx = async (
  id: string,
  delegationsAPI: DelegationInterface[],
  publicKeyNoCoord: string,
  btcWalletNetwork: networks.Network,
  signPsbtTx: SignPsbtTransaction,
  address: string,
  getNetworkFees: () => Promise<Fees>,
  pushTx: (txHex: string) => Promise<string>,
): Promise<{
  withdrawalTxHex: string;
  delegation: DelegationInterface;
}> => {
  // Check if the data is available
  if (!delegationsAPI) {
    throw new Error("No back-end API data available");
  }

  // Find the delegation in the delegations retrieved from the API
  const delegation = delegationsAPI.find(
    (delegation) => delegation.stakingTxHashHex === id,
  );
  if (!delegation) {
    throw new Error("Delegation not found");
  }

  // Get the required data
  const [paramVersions, fees] = await Promise.all([
    getGlobalParams(),
    getNetworkFees(),
  ]);

  // State of global params when the staking transaction was submitted
  const { currentVersion: globalParamsWhenStaking } =
    getCurrentGlobalParamsVersion(
      delegation.stakingTx.startHeight,
      paramVersions,
    );

  if (!globalParamsWhenStaking) {
    throw new Error("Current version not found");
  }

  const feeRate = getFeeRateFromMempool(fees);
  const phase1Staking = new Phase1Staking(btcWalletNetwork, {
    address,
    publicKeyHex: publicKeyNoCoord,
  });

  // Create the withdrawal transaction
  let withdrawPsbtTxResult: PsbtTransactionResult;
  if (delegation?.unbondingTx) {
    withdrawPsbtTxResult = phase1Staking.createWithdrawEarlyUnbondedTransaction(
      globalParamsWhenStaking,
      delegation,
      Transaction.fromHex(delegation.unbondingTx.txHex),
      feeRate.defaultFeeRate,
    );
  } else {
    withdrawPsbtTxResult =
      phase1Staking.createWithdrawTimelockUnbondedTransaction(
        globalParamsWhenStaking,
        delegation,
        feeRate.defaultFeeRate,
      );
  }

  // Sign the withdrawal transaction
  let withdrawalTx: Transaction;
  try {
    const { psbt } = withdrawPsbtTxResult;
    withdrawalTx = await signPsbtTx(psbt.toHex());
  } catch (error) {
    throw new Error("Failed to sign PSBT for the withdrawal transaction");
  }

  // Get the withdrawal transaction hex
  const withdrawalTxHex = withdrawalTx.toHex();
  // Perform a safety check on the estimated transaction fee
  txFeeSafetyCheck(
    withdrawalTx,
    feeRate.defaultFeeRate,
    withdrawPsbtTxResult.fee,
  );

  // Broadcast withdrawal transaction
  await pushTx(withdrawalTxHex);

  return { withdrawalTxHex, delegation };
};
