
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

async function checkMatches() {
    // 문서와 사용자 제보를 종합한 URL 후보
    const urls = [
        "https://archive.prod.nado.xyz/v1/matches",
        "https://gateway.prod.nado.xyz/v1/matches",
        "https://archive.prod.nado.xyz/matches",
    ];

    const payload = {
        matches: {
            subaccounts: [subaccount],
            limit: 5
        }
    };

    for (const url of urls) {
        console.log(`\n🔎 Testing: ${url}`);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            console.log(`Status: ${res.status}`);
            if (res.status === 200) {
                const text = await res.text();
                try {
                    const data = JSON.parse(text);
                    if (data.matches && data.matches.length > 0) {
                        console.log("✅ 성공! 데이터를 찾았습니다.");
                        // 첫 번째 매치 정보 출력
                        const m = data.matches[0];
                        console.log(JSON.stringify(m, null, 2));

                        // 평단가 계산 시뮬레이션
                        const base = parseFloat(m.base_filled) / 1e18;
                        const quote = parseFloat(m.quote_filled) / 1e18;
                        const price = Math.abs(quote / base);
                        console.log(`\n💡 계산된 체결가: $${price.toFixed(2)}`);
                        return;
                    }
                } catch {
                    console.log("JSON Parse Error");
                }
            } else {
                const text = await res.text();
                // console.log("Error Body:", text.slice(0, 100));
            }
        } catch (e) {
            console.log("Error: " + e);
        }
    }
    console.log("\n❌ 모든 URL 실패.");
}

checkMatches();
