# 2. feladat: összefoglaló (`summary`)

2–4 mondat a hónapról a bemenet alapján (`search`, `traffic`, `speed`, `aiAccess`, `availability`, `work`). Az átlagos pozíciónál a kisebb szám a jobb.

AI-keresők: `search.questionQueries` a kérdés jellegű és hosszabb keresések aránya, `traffic.aiAssistantVisits` az AI asszisztensekből érkezett látogatás (alsó becslés), `aiAccess` az AI-robotok hozzáférése. Ha az `aiAccess.blockedSearchBots` nem üres, azt mindenképp említsd meg: azokban az AI-keresőkben az oldal nem jelenhet meg forrásként. A `blockedTrainingBots` tiltása üzleti döntés, nem hiba.

Sebesség (`speed`): az értékelést a `...Rating` mezők adják (jó / javítandó / gyenge); küszöbértéket ne írj, az nincs a bemenetben. Indexelés (`search.indexing`): ha a `problems` nem üres, az teendő.

# 3. feladat: javaslatok (`suggestions`)

Legfeljebb 3 javaslat a bemenet adataira építve; ha nincs, a lista üres.
