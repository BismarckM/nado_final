
import { subaccountToHex } from "@nadohq/shared";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

const privateKey = process.env.NADO_PRIVATE_KEY;
if (!privateKey) throw new Error("No Private Key");
const account = privateKeyToAccount(privateKey as `0x${string}`);

const subaccount = subaccountToHex({
    subaccountOwner: account.address,
    subaccountName: 'default'
});

console.log(`🔎 Testing V2 APIs for Subaccount: ${subaccount}`);

async function testEndpoint(name: string, url: string) {
    try {
        console.log(`\nTesting ${name}: ${url}`);
        const res = await fetch(url);
        console.log(`Status: ${res.status}`);
        const text = await res.text();

        try {
            const json = JSON.parse(text);
            console.log(`✅ JSON Response keys: ${Object.keys(json).join(', ')}`);
            // 포지션 관련 데이터가 있는지 확인
            if (JSON.stringify(json).includes("entry") || JSON.stringify(json).includes("price")) {
                console.log(`Found 'entry' or 'price' keyword in response!`);
                console.log(JSON.stringify(json, null, 2).slice(0, 500));
            } else {
                console.log(`Body Preview: ${text.slice(0, 200)}`);
            }
        } catch {
            console.log(`❌ Non-JSON Response: ${text.slice(0, 200)}`);
        }
    } catch (e) {
        console.error(`Error fetching ${url}:`, e);
    }
}

async function run() {
    // 1. Gateway V2 (Likely REST endpoints corresponding to V1)
    // V1 was: client.subaccount.getSubaccountSummary -> /v1/subaccounts/{id}/summary ?
    // Let's try V2 equivalent
    await testEndpoint("Gateway V2 Summary", `https://gateway.prod.nado.xyz/v2/subaccounts/${subaccount}/summary`);
    await testEndpoint("Gateway V2 Position", `https://gateway.prod.nado.xyz/v2/positions?subaccount=${subaccount}`);

    // 2. Archive V2 (Indexer)
    // Usually provides historical data or current state from DB
    await testEndpoint("Archive V2 Fills", `https://archive.prod.nado.xyz/v2/fills?subaccount=${subaccount}&limit=5`);
    await testEndpoint("Archive V2 Positions", `https://archive.prod.nado.xyz/v2/positions?subaccount=${subaccount}`);

    // 3. Check V1 just in case Archive V1 creates clues
    await testEndpoint("Archive V1 Fills", `https://archive.prod.nado.xyz/v1/fills?subaccount=${subaccount}&limit=5`);
}

run();
