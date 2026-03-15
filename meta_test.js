const META_TOKEN = 'EAAWUGXtQx7QBQxrk0vvO3HR6YZCDQ0lWZAk60o1To38nzR0UW04i8fhoRICa0BmZAdQTDZBe8wBMTMFLUWOqtwfthKbLEGQ1bEA9s7qlBP9466RnkUUdzQFjZC9Hmw76tndW2UwJDM2LoOaCarEHSfZCWhKsx7LfEZAV9qiltlzHEFMDu4dxbDreYYUwnNORiEGRY4AgHlAkbDbDBfO4zstZC8Mzjgwui3vFpTg0c60BKMWg1ETT4CgQB51HrKBHiS4MgUPjfafbWQp91ryULE4ClQZDZD';
const META_ACT = 'act_1672579499864103';
const date = '2026-01-20';
const url = `https://graph.facebook.com/v19.0/${META_ACT}/insights?access_token=${META_TOKEN}&time_range={"since":"${date}","until":"${date}"}&fields=spend,impressions,clicks`;
fetch(url).then(r => r.json()).then(r => console.log(r));
