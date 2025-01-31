// These are utilities used by tests. They are not tested.
// Consider moving some of them to core package utils.
// And some of them to a new 'dev-util' package.
import { CardanoSerializationLib, CSL } from '@cardano-sdk/cardano-serialization-lib';
import { Ogmios } from '@cardano-sdk/core';
import { SelectionResult } from '../src/types';
import { ValueQuantities, AssetQuantities, valueToValueQuantities, valueQuantitiesToValue } from '../src/util';
import fc, { Arbitrary } from 'fast-check';

export interface TxAssets {
  key: CSL.ScriptHash;
  value: CSL.Assets;
}

export const TSLA_Asset = '659f2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba8254534c41';
export const PXL_Asset = '1ec85dcee27f2d90ec1f9a1e4ce74a667dc9be8b184463223f9c960150584c';
export const Unit_Asset = 'a5425bd7bc4182325188af2340415827a73f845846c165d9e14c5aed556e6974';
export const AllAssets = [TSLA_Asset, PXL_Asset, Unit_Asset];

/**
 * @returns {Arbitrary} fast-check arbitrary that generates valid sets of UTxO and outputs for input selection.
 */
export const generateValidUtxoAndOutputs = (() => {
  const MAX_U64 = 18_446_744_073_709_551_615n;

  type GetAssetAmount = (asset: string) => bigint;

  /**
   * @returns {boolean} true if sum of every token amount doesn't exceed provided values.
   */
  const doesntExceedAmounts = (
    quantities: ValueQuantities[],
    maxCoin = MAX_U64,
    getAssetMax: GetAssetAmount
  ): boolean => {
    const totals = Ogmios.util.coalesceValueQuantities(...quantities);
    if (totals.coins > maxCoin) {
      return false;
    }
    if (!totals.assets) {
      return true;
    }
    return Object.keys(totals.assets).every((key) => totals.assets[key] <= getAssetMax(key));
  };

  /**
   * Generate random amount of coin and assets.
   */
  const coinAndAssets = (minUtxoValue: bigint, maxCoin: bigint, getAssetMax: GetAssetAmount) =>
    fc
      .tuple(
        fc.bigInt(minUtxoValue, maxCoin),
        fc
          .set(fc.oneof(...AllAssets.map((asset) => fc.constant(asset))))
          .chain((assets) =>
            fc.tuple(...assets.map((asset) => fc.bigUint(getAssetMax(asset)).map((amount) => ({ asset, amount }))))
          )
          .map((assets) =>
            assets
              .filter(({ amount }) => amount > 0n)
              .reduce((quantities, { amount, asset }) => {
                quantities[asset] = amount;
                return quantities;
              }, {} as AssetQuantities)
          )
      )
      .map(([coins, assets]): ValueQuantities => ({ coins, assets }));

  /**
   * Generate an array of random quantities of coin and assets.
   */
  const arrayOfCoinAndAssets = (minUtxoValue: bigint, maxCoin = MAX_U64, getAssetMax: GetAssetAmount = () => MAX_U64) =>
    fc
      .array(coinAndAssets(minUtxoValue, maxCoin, getAssetMax))
      // Verify that sum of all array items doesn't exceed limit quantities
      .filter((results) => doesntExceedAmounts(results, maxCoin, getAssetMax));

  return (
    // TODO: when working on improving tests,
    // create MockSelectionConstraints type, where functions don't need any args
    // and pass the entire object to create this arbitrary
    minUtxoValue: bigint
  ): Arbitrary<{
    utxoAmounts: ValueQuantities[];
    outputsAmounts: ValueQuantities[];
  }> =>
    arrayOfCoinAndAssets(minUtxoValue).chain((utxoAmounts) => {
      // Generate outputs with quantities not exceeding utxo quantities.
      // Testing balance insufficient and other failures in example-based tests.
      if (utxoAmounts.length === 0) {
        return fc.constant({ utxoAmounts, outputsAmounts: [] });
      }
      const utxoTotals = Ogmios.util.coalesceValueQuantities(...utxoAmounts);
      return arrayOfCoinAndAssets(minUtxoValue, utxoTotals.coins, (asset) => utxoTotals.assets?.[asset] || 0n)
        .filter((outputsAmounts) => {
          const outputsTotals = Ogmios.util.coalesceValueQuantities(...outputsAmounts);
          // Change has to be >= minUtxoValue
          return utxoTotals.coins - outputsTotals.coins >= minUtxoValue;
        })
        .map((outputsAmounts) => ({ utxoAmounts, outputsAmounts }));
    });
})();

/**
 * Checks whether UTxO is included in an array of UTxO.
 * Compares utxo.to_bytes().
 */
export const containsUtxo = (haystack: CSL.TransactionUnspentOutput[], needleUtxo: CSL.TransactionUnspentOutput) => {
  const needleUtxoBytes = needleUtxo.to_bytes();
  return haystack.some((haystackUtxo: CSL.TransactionUnspentOutput) => {
    const haystackUtxoBytes = haystackUtxo.to_bytes();
    if (haystackUtxoBytes.length !== needleUtxoBytes.length) {
      return false;
    }
    for (const [idx, utxoByte] of needleUtxoBytes.entries()) {
      if (haystackUtxoBytes[idx] !== utxoByte) {
        return false;
      }
    }
    return true;
  });
};

const getTotalOutputAmounts = (outputs: CSL.TransactionOutput[]): ValueQuantities => {
  let result: ValueQuantities = {
    coins: 0n,
    assets: {} as Record<string, bigint>
  };
  for (const output of outputs) {
    const amount = output.amount();
    result = Ogmios.util.coalesceValueQuantities(result, valueToValueQuantities(amount));
  }
  return result;
};

const getTotalInputAmounts = (results: SelectionResult): ValueQuantities =>
  results.selection.inputs
    .map((input) => input.output().amount())
    .reduce<ValueQuantities>((sum, value) => Ogmios.util.coalesceValueQuantities(sum, valueToValueQuantities(value)), {
      coins: 0n,
      assets: {}
    });

const getTotalChangeAmounts = (results: SelectionResult): ValueQuantities =>
  results.selection.change.reduce<ValueQuantities>(
    (sum, value) => Ogmios.util.coalesceValueQuantities(sum, valueToValueQuantities(value)),
    {
      assets: {},
      coins: 0n
    }
  );

export const createCslTestUtils = (csl: CardanoSerializationLib) => {
  const createTxInput = (() => {
    let defaultIdx = 0;
    return (bech32TxHash = 'base16_1sw0vvt7mgxghdewkrsptd2n0twueg2a7q88t9cjhtqmpk7xwc07shpk2uq', index?: number) =>
      csl.TransactionInput.new(csl.TransactionHash.from_bech32(bech32TxHash), index || defaultIdx++);
  })();

  const createOutputsObj = (outputs: CSL.TransactionOutput[]) => {
    const result = csl.TransactionOutputs.new();
    for (const output of outputs) {
      result.add(output);
    }
    return result;
  };

  const createUnspentTxOutput = (
    valueQuantities: ValueQuantities,
    bech32Addr = 'addr1vy36kffjf87vzkuyqc5g0ys3fe3pez5zvqg9r5z9q9kfrkg2cs093'
  ): CSL.TransactionUnspentOutput => {
    const address = csl.Address.from_bech32(bech32Addr);
    const amount = valueQuantitiesToValue(valueQuantities, csl);
    return csl.TransactionUnspentOutput.new(createTxInput(), csl.TransactionOutput.new(address, amount));
  };

  const createOutput = (
    valueQuantities: ValueQuantities,
    bech32Addr = 'addr1vyeljkh3vr4h9s3lyxe7g2meushk3m4nwyzdgtlg96e6mrgg8fnle'
  ): CSL.TransactionOutput =>
    csl.TransactionOutput.new(csl.Address.from_bech32(bech32Addr), valueQuantitiesToValue(valueQuantities, csl));

  return {
    createUnspentTxOutput,
    createOutput,
    createOutputsObj,
    getTotalOutputAmounts,
    getTotalInputAmounts,
    getTotalChangeAmounts
  };
};

export type TestUtils = ReturnType<typeof createCslTestUtils>;
