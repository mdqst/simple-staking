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

export interface BbnStakingInputs {
  bech32Address: string;
}

export enum StakingStep {
  Staking = "staking",
  Unbonding = "unbonding",
  StakingOutputSlashing = "staking-output-slashing",
  UnbondingOutputSlashing = "unbonding-output-slashing",
  ProofOfPossession = "proof-of-possession",
  SubmitBbnTx = "submit-bbn-tx",
}

export const createBtcDelegation = async (
  btcInput: BtcStakingInputs,
  bbnInput: BbnStakingInputs,
  signBtcPsbt: (step: StakingStep, psbtHex: string) => Promise<string>,
  signMessageBIP322: (step: StakingStep, message: string) => Promise<string>,
  sendBbnTx: (step: StakingStep, tx: Uint8Array) => Promise<void>,
) => {
  const staking = new Staking(
    btcInput.btcNetwork,
    btcInput.stakerInfo,
    btcInput.params,
    btcInput.finalityProviderPublicKey,
    btcInput.stakingTimeBlocks,
  );
  // Create Staking Transaction (no need to sign)
  const { psbt: stakingPsbt } = staking.createStakingTransaction(
    btcInput.stakingAmountSat,
    btcInput.inputUTXOs,
    btcInput.feeRate,
  );
  const signedStakingPsbtHex = await signBtcPsbt(
    StakingStep.Staking,
    stakingPsbt.toHex(),
  );
  // TODO: Temporary solution to get the stakingTx.
  const stakingTx = Psbt.fromHex(signedStakingPsbtHex).extractTransaction();
  // Create unbonding tx (no need to sign)
  const { psbt: unbondingPsbt } = staking.createUnbondingTransaction(stakingTx);
  // TODO: Temporary solution to get the UnbondingTx.
  const signedUnbondingPsbtHex = await signBtcPsbt(
    StakingStep.Unbonding,
    unbondingPsbt.toHex(),
  );
  const unbondingTx = Psbt.fromHex(signedUnbondingPsbtHex).extractTransaction();

  // Create and signed slashing txs
  const { psbt: slashingPsbt } =
    staking.createStakingOutputSlashingTransaction(stakingTx);
  const signedStakingOutputSlashingPsbtHex = await signBtcPsbt(
    StakingStep.StakingOutputSlashing,
    slashingPsbt.toHex(),
  );
  const signedSlashingTx = Psbt.fromHex(
    signedStakingOutputSlashingPsbtHex,
  ).extractTransaction();

  const stakingOutputSignatures =
    extractSchnorrSignaturesFromTransaction(signedSlashingTx);
  if (!stakingOutputSignatures) {
    throw new Error("No signature found in the staking output slashing PSBT");
  }

  const { psbt: slashUnbondingPsbt } =
    staking.createUnbondingOutputSlashingTransaction(unbondingTx);
  const signedUnbondingSlashingPsbtHex = await signBtcPsbt(
    StakingStep.UnbondingOutputSlashing,
    slashUnbondingPsbt.toHex(),
  );
  const signedUnbondingSlashingTx = Psbt.fromHex(
    signedUnbondingSlashingPsbtHex,
  ).extractTransaction();

  const unbondingSignatures = extractSchnorrSignaturesFromTransaction(
    signedUnbondingSlashingTx,
  );
  if (!unbondingSignatures) {
    throw new Error("No signature found in the unbonding output slashing PSBT");
  }

  // Sign the BBN address
  const signedBbnAddress = await signMessageBIP322(
    StakingStep.ProofOfPossession,
    bbnInput.bech32Address,
  );

  // TODO: Move it outside
  const proofOfPossession: ProofOfPossessionBTC = {
    btcSigType: BTCSigType.BIP322,
    btcSig: Buffer.from(signedBbnAddress, "base64"),
  };

  const msg: btcstakingtx.MsgCreateBTCDelegation = {
    stakerAddr: btcInput.stakerAddress,
    pop: proofOfPossession,
    btcPk: Uint8Array.from(Buffer.from(btcInput.stakerNocoordPk, "hex")),
    fpBtcPkList: [
      Uint8Array.from(Buffer.from(btcInput.finalityProviderPublicKey, "hex")),
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
      Buffer.from(clearTxSignatures(signedUnbondingSlashingTx).toHex(), "hex"),
    ),
    delegatorUnbondingSlashingSig: Uint8Array.from(unbondingSignatures),
    stakingTxInclusionProof: undefined,
  };

  const protoMsg = {
    typeUrl: "/babylon.btcstaking.v1.MsgCreateBTCDelegation",
    value: btcstakingtx.MsgCreateBTCDelegation.encode(msg).finish(),
  };
  return sendBbnTx(StakingStep.SubmitBbnTx, protoMsg.value);
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
