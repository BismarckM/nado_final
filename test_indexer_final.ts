
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

async function checkIndexer() {
    // 문서 분석 결과: 루트 URL에 POST 요청
    const url = "https://archive.prod.nado.xyz/v1";

    const payload = {
        matches: {
            subaccounts: [subaccount],
            limit: 10
        }
    };

    console.log(`🔎 Testing Indexer Root URL: ${url}`);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // "Accept-Encoding": "gzip, br, deflate" // Node fetch handles this automatically usually
            },
            body: JSON.stringify(payload)
        });

        console.log(`Status: ${res.status}`);
        const text = await res.text();

        if (res.status === 200) {
            const data = JSON.parse(text);
            if (data.matches) {
                console.log(`✅ Success! Found ${data.matches.length} matches.`);
                if (data.matches.length > 0) {
                    const m = data.matches[0];
                    console.log("[Latest Match Sample]");
                    console.log(JSON.stringify(m, null, 2));

                    // 평단가 계산 검증
                    const base = parseFloat(m.base_filled) / 1e18;
                    const quote = parseFloat(m.quote_filled) / 1e18;
                    const price = Math.abs(quote / base);
                    console.log(`💡 Calced Price: $${price.toFixed(2)}`);
                }
            } else {
                console.log("Response OK but no 'matches' key:", text.slice(0, 500));
            }
        } else {
            console.log(`❌ Error: ${res.status}`);
            console.log(text.slice(0, 500));
        }
    } catch (e) {
        console.error(e);
    }
}

checkIndexer();
