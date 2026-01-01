
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

async function checkRPC() {
    const baseUrls = [
        "https://gateway.prod.nado.xyz/v1",
        "https://gateway.prod.nado.xyz/v2",
    ];

    // Nado API(또는 Hyperliquid 스타일) 엔드포인트 추측
    const endpoints = ["", "/info", "/query",];

    const payloads = [
        { type: "webData2", user: account.address }, // Hyperliquid 포지션 조회용
        { type: "clearinghouseState", user: account.address },
        { type: "userState", user: account.address },
        { type: "subaccountSummary", subaccount: subaccount } // REST일 경우
    ];

    console.log(`🔎 Testing RPC for user: ${account.address}`);

    for (const base of baseUrls) {
        for (const ep of endpoints) {
            const url = base + ep;
            // console.log(`Testing ${url}...`);

            for (const body of payloads) {
                try {
                    const res = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body)
                    });

                    if (res.status === 200) {
                        const text = await res.text();
                        console.log(`✅ Success [${url}] [${body.type}]`);

                        if (text.includes("entryPx") || text.includes("entryPrice")) {
                            console.log("🌟 FOUND ENTRY PRICE DATA!");
                            console.log(text.slice(0, 500));
                            return; // 찾으면 종료
                        } else {
                            // console.log(text.slice(0, 200));
                        }
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
        }
    }
    console.log("❌ Failed to find entry price in any endpoint.");
}

checkRPC();
