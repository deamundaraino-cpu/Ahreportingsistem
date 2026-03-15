const META_TOKEN = 'EAAWUGXtQx7QBQxrk0vvO3HR6YZCDQ0lWZAk60o1To38nzR0UW04i8fhoRICa0BmZAdQTDZBe8wBMTMFLUWOqtwfthKbLEGQ1bEA9s7qlBP9466RnkUUdzQFjZC9Hmw76tndW2UwJDM2LoOaCarEHSfZCWhKsx7LfEZAV9qiltlzHEFMDu4dxbDreYYUwnNORiEGRY4AgHlAkbDbDBfO4zstZC8Mzjgwui3vFpTg0c60BKMWg1ETT4CgQB51HrKBHiS4MgUPjfafbWQp91ryULE4ClQZDZD';
const META_ACT = 'act_1672579499864103';

async function checkMeta() {
    const url = `https://graph.facebook.com/v19.0/${META_ACT}/insights?access_token=${META_TOKEN}&time_range={"since":"2026-01-20","until":"2026-01-25"}&fields=spend,impressions,clicks`;
    console.log('Fetching:', url);
    try {
        const res = await fetch(url);
        const data = await res.json();
        console.log('Meta Result:', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Meta Request failed:', err.message);
    }
}

const HOTMART_BASIC = 'MjVjMzY1ZjctN2I5Zi00ZGNlLTg0MmQtZDU1N2M0Yzc4MGE3OjRiYTFhYjVmLTMyNzEtNGU2Zi05YjQ3LTkyYzBkNDk0OWY1MQ==';
const HOTMART_CLIENT_ID = '25c365f7-7b9f-4dce-842d-d557c4c780a7';
const HOTMART_CLIENT_SECRET = '4ba1ab5f-3271-4e6f-9b47-92c0d4949f51';

async function checkHotmart() {
    const tokenUrl = `https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials`;
    try {
        const tokenRes = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${HOTMART_BASIC}`
            },
            // body: JSON.stringify({ client_id: HOTMART_CLIENT_ID, client_secret: HOTMART_CLIENT_SECRET })
        });
        const tokenData = await tokenRes.json();
        console.log('Hotmart Token:', tokenData.access_token ? "Obtenido" : "Fallo", tokenData);

        if (tokenData.access_token) {
            const startMillis = new Date('2026-01-01T00:00:00Z').getTime();
            const endMillis = new Date('2026-01-31T23:59:59Z').getTime();
            const url = `https://developers.hotmart.com/payments/api/v1/sales/history?start_date=${startMillis}&end_date=${endMillis}`;

            const req = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`
                }
            })
            const data = await req.json();
            console.log('Hotmart Sales:', JSON.stringify(data, null, 2).substring(0, 1000));
        }
    } catch (err) {
        console.error('Hotmart err:', err);
    }
}

checkMeta();
checkHotmart();
