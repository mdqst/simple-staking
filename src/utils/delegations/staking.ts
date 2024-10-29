import { btcstakingtx } from "@babylonlabs-io/babylon-proto-ts";
import {
  BTCSigType,
  ProofOfPossessionBTC,
} from "@babylonlabs-io/babylon-proto-ts/dist/generated/babylon/btcstaking/v1/pop";
import {
  StakerInfo,
  Staking,
  StakingParams,
  UTXO,
} from "@babylonlabs-io/btc-staking-ts";
import { networks, Psbt, Transaction } from "bitcoinjs-lib";
import { useCallback } from "react";

import { useBTCWallet } from "@/app/context/wallet/BTCWalletProvider";
import { useCosmosWallet } from "@/app/context/wallet/CosmosWalletProvider";

export interface BtcStakingInputs {
  btcNetwork: networks.Network;
  stakerInfo: StakerInfo;
  stakerAddress: string;
  stakerNocoordPk: string;
  finalityProviderPublicKey: string;
  stakingAmountSat: number;
  stakingTimeBlocks: number;
  inputUTXOs: UTXO[];
  feeRate: number;
  params: StakingParams;
}

export enum StakingStep {
  Staking = "staking",
  Unbonding = "unbonding",
  StakingOutputSlashing = "staking-output-slashing",
  UnbondingOutputSlashing = "unbonding-output-slashing",
  ProofOfPossession = "proof-of-possession",
  SubmitBbnTx = "submit-bbn-tx",
}

export const useCreateBtcDelegation = () => {
  const { connected, bech32Address, getSigningStargateClient } =
    useCosmosWallet();
  const { signPsbt, signMessageBIP322 } = useBTCWallet();

  const createBtcDelegation = useCallback(
    async (btcInput: BtcStakingInputs) => {
      const staking = new Staking(
        btcInput.btcNetwork,
        btcInput.stakerInfo,
        btcInput.params,
        btcInput.finalityProviderPublicKey,
        btcInput.stakingTimeBlocks,
      );

      try {
        // Create and sign staking transaction
        const { psbt: stakingPsbt } = staking.createStakingTransaction(
          btcInput.stakingAmountSat,
          btcInput.inputUTXOs,
          btcInput.feeRate,
        );
        const signedStakingPsbtHex = await signPsbt(stakingPsbt.toHex());
        const stakingTx =
          Psbt.fromHex(signedStakingPsbtHex).extractTransaction();

        // Create and sign unbonding transaction
        const { psbt: unbondingPsbt } =
          staking.createUnbondingTransaction(stakingTx);
        const signedUnbondingPsbtHex = await signPsbt(unbondingPsbt.toHex());
        const unbondingTx = Psbt.fromHex(
          signedUnbondingPsbtHex,
        ).extractTransaction();

        // Create slashing transactions and extract signatures
        const { psbt: slashingPsbt } =
          staking.createStakingOutputSlashingTransaction(stakingTx);
        const signedSlashingPsbtHex = await signPsbt(slashingPsbt.toHex());
        const signedSlashingTx = Psbt.fromHex(
          signedSlashingPsbtHex,
        ).extractTransaction();
        const stakingOutputSignatures =
          extractSchnorrSignaturesFromTransaction(signedSlashingTx);

        if (!stakingOutputSignatures) {
          throw new Error(
            "No signature found in the staking output slashing PSBT",
          );
        }

        const { psbt: unbondingSlashingPsbt } =
          staking.createUnbondingOutputSlashingTransaction(unbondingTx);
        const signedUnbondingSlashingPsbtHex = await signPsbt(
          unbondingSlashingPsbt.toHex(),
        );
        const signedUnbondingSlashingTx = Psbt.fromHex(
          signedUnbondingSlashingPsbtHex,
        ).extractTransaction();
        const unbondingSignatures = extractSchnorrSignaturesFromTransaction(
          signedUnbondingSlashingTx,
        );

        if (!unbondingSignatures) {
          throw new Error(
            "No signature found in the unbonding output slashing PSBT",
          );
        }

        // Create Proof of Possession
        const signedBbnAddress = await signMessageBIP322(bech32Address);
        const proofOfPossession: ProofOfPossessionBTC = {
          btcSigType: BTCSigType.BIP322,
          btcSig: Uint8Array.from(Buffer.from(signedBbnAddress, "base64")),
        };

        // Prepare and send protobuf message
        const msg: btcstakingtx.MsgCreateBTCDelegation = {
          stakerAddr: btcInput.stakerAddress,
          pop: proofOfPossession,
          btcPk: Uint8Array.from(Buffer.from(btcInput.stakerNocoordPk, "hex")),
          fpBtcPkList: [
            Uint8Array.from(
              Buffer.from(btcInput.finalityProviderPublicKey, "hex"),
            ),
          ],
          stakingTime: btcInput.stakingTimeBlocks,
          stakingValue: btcInput.stakingAmountSat,
          stakingTx: Uint8Array.from(
            Buffer.from(clearTxSignatures(stakingTx).toHex(), "hex"),
          ),
          slashingTx: Uint8Array.from(
            Buffer.from(clearTxSignatures(signedSlashingTx).toHex(), "hex"),
          ),
          delegatorSlashingSig: Uint8Array.from(stakingOutputSignatures),
          unbondingTime: btcInput.params.unbondingTime,
          unbondingTx: Uint8Array.from(
            Buffer.from(clearTxSignatures(unbondingTx).toHex(), "hex"),
          ),
          unbondingValue: btcInput.params.unbondingFeeSat,
          unbondingSlashingTx: Uint8Array.from(
            Buffer.from(
              clearTxSignatures(signedUnbondingSlashingTx).toHex(),
              "hex",
            ),
          ),
          delegatorUnbondingSlashingSig: Uint8Array.from(unbondingSignatures),
          stakingTxInclusionProof: undefined,
        };

        const protoMsg = {
          typeUrl: "/babylon.btcstaking.v1.MsgCreateBTCDelegation",
          value: btcstakingtx.MsgCreateBTCDelegation.encode(msg).finish(),
        };
        if (!connected) {
          throw new Error("Not connected to a wallet");
        }

        const stargateClient = await getSigningStargateClient();
        // estimate gas
        const gasEstimate = await stargateClient.simulate(
          bech32Address,
          [protoMsg],
          "estimate fee",
        );
        const fee = {
          amount: [{ denom: "ubbn", amount: (gasEstimate * 1.5).toFixed(0) }],
          gas: gasEstimate.toString(),
        };
        // sign it
        const result = await stargateClient.signAndBroadcast(
          bech32Address,
          [protoMsg],
          fee,
        );
        console.log("result", result);
      } catch (error) {
        console.error("Failed to create BTC Delegation:", error);
      }
    },
    [bech32Address, signPsbt, signMessageBIP322, getSigningStargateClient],
  );

  return { createBtcDelegation };
};

const extractSchnorrSignaturesFromTransaction = (
  singedTransaction: Transaction,
): Buffer | undefined => {
  // Loop through each input to extract the witness signature
  for (const input of singedTransaction.ins) {
    if (input.witness && input.witness.length > 0) {
      const schnorrSignature = input.witness[0];

      // Check that it's a 64-byte Schnorr signature
      if (schnorrSignature.length === 64) {
        return schnorrSignature; // Return the first valid signature found
      }
    }
  }
  return undefined;
};

const clearTxSignatures = (tx: Transaction): Transaction => {
  tx.ins.forEach((input) => {
    input.script = Buffer.alloc(0);
    input.witness = [];
  });
  return tx;
};
