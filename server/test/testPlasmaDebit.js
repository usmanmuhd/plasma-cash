const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");
const LoomToken = artifacts.require("LoomToken");
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");
import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

contract("Plasma Debit - All In One", async function(accounts) {

    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;
    const coins = [1, 2, 3];

    let erc20;
    let erc721;
    let plasma;
    let vmc;
    let events;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger] = accounts;

    const DECIMALS = 10 ** 18;
    const denominations = [
        3000 * DECIMALS, 
        2000 * DECIMALS, 
        4000 * DECIMALS
    ];

    const ethers = [
        web3.toWei(1, 'ether'),
        web3.toWei(4, 'ether'),
        web3.toWei(5, 'ether')
    ];

    beforeEach(async function() {
        vmc = await ValidatorManagerContract.new({from: authority});
        plasma = await RootChain.new(vmc.address, {from: authority});
        erc20 = await LoomToken.new(plasma.address, {from: authority});
        erc721 = await CryptoCards.new(plasma.address, {from: authority});

        await vmc.toggleToken(erc20.address, {from: authority});
        await vmc.toggleToken(erc721.address, {from: authority});

        await erc20.transfer(alice, 10000 * DECIMALS, {from: authority});
        await erc721.register({from: alice});

        for (let i = 0; i < denominations.length; i ++) {
            await web3.eth.sendTransaction({from: alice, to: plasma.address, value: ethers[i], gas: 250000 });
            await erc20.depositToPlasma(denominations[i], {from: alice});
            await erc721.depositToPlasma(coins[i], {from: alice});
        }
        assert.equal(await erc20.balanceOf.call(alice), 1000 * DECIMALS);
        assert.equal(await erc20.balanceOf.call(plasma.address), 9000 * DECIMALS);

        assert.equal(await erc721.balanceOf.call(plasma.address), 3);
        assert.equal(await erc721.balanceOf.call(alice), 2);

        assert.equal(await web3.eth.getBalance(plasma.address), web3.toWei(10, 'ether'));

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        events = await txlib.Promisify(cb => depositEvent.get(cb));
    });

    describe('Plasma Debit', function() {
		it('Operator provides liquidity!', async function() {
			let UTXO = [
                {'slot': events[0]['args'].slot, 'block': events[0]['args'].blockNumber.toNumber()},
                {'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
            ]
            // Fill up the ETH token
            await plasma.provideLiquidity(UTXO[0].slot, 0, {'value':  web3.toWei(14, 'ether') });
            // Fill up the ERC20 token
            await erc20.approve(plasma.address, 4000 * DECIMALS, {from: authority});
            await plasma.provideLiquidity(UTXO[1].slot, 4000 * DECIMALS, {from: authority});

            let prevBlock = 0;
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let ret = txlib.createUTXO(aUTXO.slot, prevBlock, alice, alice);
                let utxo = ret.tx;
                let sig = ret.sig;

                await plasma.startExit(
                    aUTXO.slot,
                    '0x', utxo,
                    '0x0', '0x0',
                    sig,
                    [prevBlock, aUTXO.block],
                    {'from': alice, 'value': web3.toWei(0.1, 'ether')}
                );
            }
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1);
            await plasma.finalizeExits({from: random_guy2 });

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                await plasma.withdraw(aUTXO.slot, {from : alice });
            }

            const withdrewEvent = plasma.Withdrew({}, {fromBlock: 0, toBlock: 'latest'});
            const withdrew = await txlib.Promisify(cb => withdrewEvent.get(cb));

            // The authority should have got the liquidity provided back.
            assert.equal(withdrew[0]['args'].denomination, web3.toWei(1, 'ether'));
            assert.equal(withdrew[0]['args'].toOperator, web3.toWei(14, 'ether'));
            assert.equal(withdrew[1]['args'].denomination, 3000 * DECIMALS);
            assert.equal(withdrew[1]['args'].toOperator, 4000 * DECIMALS);
            // Alice has her coins back.
            await txlib.withdrawBonds(plasma, alice, 0.2);
        });


    });

});
