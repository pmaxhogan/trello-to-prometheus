#!/usr/bin/env node
"use strict";

/**
 * Plain Node HTTP server that exposes Prometheus metrics for a single Trello board.
 *
 * Environment variables required:
 * - TRELLO_KEY   : your Trello API key
 * - TRELLO_TOKEN : your Trello API token
 * - BOARD_ID     : Trello board id to scrape
 * - PORT         : (optional) HTTP port, default 3000
 *
 * Usage:
 *   TRELLO_KEY=xxx TRELLO_TOKEN=yyy BOARD_ID=zzzz node trello-prometheus-http-server.js
 *
 * Then peep: http://localhost:3000/metrics
 */

import "dotenv/config";


import http from "http";
import {URL} from "url";


// ---- Config ----
const PORT = Number(process.env.PORT || 3000);
const TRELLO_KEY = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const BOARD_ID = process.env.TRELLO_BOARD_ID || "";

const API_TOKEN = process.env.API_TOKEN || ""; // Optional API token for authentication


if (!TRELLO_KEY || !TRELLO_TOKEN || !BOARD_ID) {
    throw new Error("Missing env: TRELLO_KEY, TRELLO_TOKEN, BOARD_ID are required.");
}

if(!API_TOKEN){
    console.error("API is unauthenticated, use API_TOKEN env variable to set a token for authentication.");
}

// Node >=18 has global fetch. If not available, instruct user to upgrade Node or polyfill.
if (typeof fetch !== "function") {
    throw new Error("Global fetch not found. Use Node.js v18+ or install a fetch polyfill.");
}

const API = "https://api.trello.com/1";

function trelloQuery(params = {}) {
    const sp = new URLSearchParams({ key: TRELLO_KEY, token: TRELLO_TOKEN });
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) sp.append(k, String(v));
    }
    return sp.toString();
}

async function trelloGet(path, params = {}) {
    const url = `${API}${path}?${trelloQuery(params)}`;
    const res = await fetch(url);
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Trello GET ${path} failed: ${res.status} ${res.statusText} ${text}`);
    }
    return res.json();
}

// ---- Helpers to format Prometheus exposition ----
function escapeLabel(value = "") {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
}

function formatPrometheusMetrics(metrics) {
    let output = "";
    for (const [metricName, metricData] of Object.entries(metrics)) {
        output += `# TYPE ${metricName} gauge\n`;
        output += `# HELP ${metricName} ${metricData.help}\n`;
        for (const sample of metricData.samples) {
            const labels = Object.entries(sample.labels || {})
                .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
                .join(", ");
            output += `${metricName}{${labels}} ${sample.value}\n`;
        }
    }
    return output;
}

// ---- Domain constants copied from the original Pipedream component ----
const timeMap = {
    "6317987e46e82a010a822ec0": { range: "<5 min", max: "5 min", med: "3 minutes", s: 180 },
    "6317987e46e82a010a822ec1": { range: "5 min - 15 min", max: "5 min", med: "10 minutes", s: 600 },
    "6317987e46e82a010a822ec2": { range: "15 min - 30 min", max: "5 min", med: "23 minutes", s: 1380 },
    "6317987e46e82a010a822ec3": { range: "30 min - 1 hour", max: "5 min", med: "45 minutes", s: 2700 },
    "6317987e46e82a010a822ec4": { range: "1 hour - 3 hours", max: "5 min", med: "2 hours", s: 7200 },
    "6317987e46e82a010a822ec5": { range: "3+ hours", max: "5 min", med: "4 hours", s: 14400 }
};

const priorityMap = {
    "63237551f4e1250062d584d7": "Highest",
    "63237551f4e1250062d584d8": "High",
    "63237551f4e1250062d584d9": "Medium",
    "63237551f4e1250062d584da": "Low",
    "63237551f4e1250062d584db": "Lowest"
};


const listNameToId = {
    Inbox: "67f45c29f80d25da0f543428",
    Ref: "640fbcf689fe9b86e3721b60",
    Decomp: "67291a8ff4e1941fe4df8c71",
    Ready: "62ba39f3660d8d5b9ec940fe",
    Today: "6601f48e27469813be23ba2e",
    Blocked: "62ba548b2155ca280fefba5b",
    Progress: "62ba39f599d17e0e24c5a212",
    Work: "65b184b75a5f898ab7010288",
    Done: "62ba39f7fc9ece2c518208a7",
};

const labelNameToId = {
    // ...incomplete...
    Divider: "681a3bbe267f382f9ed138e8",
}

const listsToIgnore = [listNameToId.Ref, listNameToId.Decomp]; // ignore by id
const doneLists = [listNameToId.Done]; // list ids considered done
const ignoreCardsWithAtLeastOneOfTheseLabelIds = [labelNameToId.Divider]; // label ids to ignore

// ---- Core logic to build metrics ----
async function buildMetrics() {
    const metrics = {
        trello_boards_total: { help: "Total number of Trello boards", samples: [] },
        trello_cards_in_list_total: { help: "Number of cards per list", samples: [] },
        trello_labeled_cards_on_board: { help: "Number of cards per board and label", samples: [] },
        trello_cards_per_board_member: { help: "Number of cards per board and member", samples: [] },
        trello_lists_per_board: { help: "Number of lists per board", samples: [] },
        trello_time_in_list_total: { help: "Total estimated time in each list (in seconds)", samples: [] },
        trello_cards_by_priority_total: { help: "Number of cards by priority (excluding done cards)", samples: [] },
        trello_cards_by_time_total: { help: "Number of cards by time (excluding done cards)", samples: [] },
    };

    metrics.trello_boards_total.samples.push({ labels: {}, value: 1 });

    // Fetch in parallel
    const [board, listsRaw, labels, members, cardsRaw] = await Promise.all([
        trelloGet(`/boards/${BOARD_ID}`, { fields: "name" }),
        trelloGet(`/boards/${BOARD_ID}/lists`, { fields: "name" }),
        trelloGet(`/boards/${BOARD_ID}/labels`, { fields: "name,color" }),
        trelloGet(`/boards/${BOARD_ID}/members`, { fields: "fullName,username" }),
        trelloGet(`/boards/${BOARD_ID}/cards`, { customFieldItems: "true", limit: 1000 }),
    ]);

    const boardName = escapeLabel(board?.name || "(unknown)");

    // Filter lists
    const lists = (listsRaw || []).filter((l) => !listsToIgnore.includes(l.id));

    // Filter cards
    let cards = (cardsRaw || []).filter((c) => {
        if (!c || !c.idList) return false;
        if (listsToIgnore.includes(c.idList)) return false;
        if (Array.isArray(c.idLabels) && c.idLabels.some((l) => ignoreCardsWithAtLeastOneOfTheseLabelIds.includes(l))) return false;
        // noinspection RedundantIfStatementJS -- its cleaner this way trust
        if (c.cardRole === "separator") return false;
        return true;
    });

    // Enrich cards with customInfo
    cards = cards.map((c) => {
        const custom = { time: undefined, priority: undefined };
        const items = Array.isArray(c.customFieldItems) ? c.customFieldItems : [];
        for (const item of items) {
            if (item && item.idValue && Object.prototype.hasOwnProperty.call(timeMap, item.idValue)) {
                custom.time = timeMap[item.idValue];
            }
            if (item && item.idValue && Object.prototype.hasOwnProperty.call(priorityMap, item.idValue)) {
                custom.priority = priorityMap[item.idValue];
            }
        }
        return { ...c, customInfo: custom };
    });

    // Lists per board
    metrics.trello_lists_per_board.samples.push({ labels: { board: boardName }, value: lists.length });

    // Cards per list (exclude archived cards)
    const cardsByList = {};
    for (const card of cards) {
        if (!card.closed) {
            cardsByList[card.idList] = (cardsByList[card.idList] || 0) + 1;
        }
    }
    for (const list of lists) {
        const cardCount = cardsByList[list.id] || 0;
        metrics.trello_cards_in_list_total.samples.push({
            labels: { board: boardName, list: escapeLabel(list.name) },
            value: cardCount,
        });
    }

    // Cards by priority (excluding done lists)
    const cardsByPriority = {};
    for (const card of cards) {
        if (!card.closed && card.customInfo?.priority && !doneLists.includes(card.idList)) {
            const p = card.customInfo.priority;
            cardsByPriority[p] = (cardsByPriority[p] || 0) + 1;
        }
    }
    for (const priority of Object.values(priorityMap)) {
        const cardCount = cardsByPriority[priority] || 0;
        metrics.trello_cards_by_priority_total.samples.push({
            labels: { board: boardName, priority: escapeLabel(priority) },
            value: cardCount,
        });
    }

    // Cards by time (excluding archived, but not excluding done lists per original logic)
    const cardsByTime = {};
    for (const card of cards) {
        if (!card.closed && card.customInfo?.time) {
            const r = card.customInfo.time.range;
            cardsByTime[r] = (cardsByTime[r] || 0) + 1;
        }
    }
    for (const t of Object.values(timeMap)) {
        const cardCount = cardsByTime[t.range] || 0;
        metrics.trello_cards_by_time_total.samples.push({
            labels: { board: boardName, time: escapeLabel(t.range) },
            value: cardCount,
        });
    }

    // Total estimated time in each list (seconds)
    const cardTimeByList = {};
    for (const card of cards) {
        if (!card.closed && card.customInfo?.time) {
            cardTimeByList[card.idList] = (cardTimeByList[card.idList] || 0) + (card.customInfo.time.s || 0);
        }
    }
    for (const list of lists) {
        const totalSeconds = cardTimeByList[list.id] || 0;
        metrics.trello_time_in_list_total.samples.push({
            labels: { board: boardName, list: escapeLabel(list.name) },
            value: totalSeconds,
        });
    }

    // Cards per label
    const cardsByLabel = {};
    for (const card of cards) {
        if (!card.closed && Array.isArray(card.idLabels) && card.idLabels.length) {
            for (const labelId of card.idLabels) {
                cardsByLabel[labelId] = (cardsByLabel[labelId] || 0) + 1;
            }
        }
    }
    for (const label of labels || []) {
        const count = cardsByLabel[label.id] || 0;
        if (count > 0) {
            const labelName = label.name || label.color || "unlabeled";
            metrics.trello_labeled_cards_on_board.samples.push({
                labels: { board: boardName, label: escapeLabel(labelName) },
                value: count,
            });
        }
    }

    // Cards per member
    const cardsByMember = {};
    for (const card of cards) {
        if (!card.closed && Array.isArray(card.idMembers) && card.idMembers.length) {
            for (const memberId of card.idMembers) {
                cardsByMember[memberId] = (cardsByMember[memberId] || 0) + 1;
            }
        }
    }
    for (const m of members || []) {
        const count = cardsByMember[m.id] || 0;
        if (count > 0) {
            const memberName = m.fullName || m.username || m.id;
            metrics.trello_cards_per_board_member.samples.push({
                labels: { board: boardName, member: escapeLabel(memberName) },
                value: count,
            });
        }
    }

    return formatPrometheusMetrics(metrics);
}


function checkAuth(req) {
    if(!API_TOKEN) return true; // No auth token set, skip auth check

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return false; // No auth header or not Bearer
    }

    const token = authHeader.slice(7); // Remove "Bearer " prefix
    // TODO: timing-safe equal check (unfortunately idgaf rn)
    return token === API_TOKEN; // Check if token matches
}

console.log(await buildMetrics());

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === "/metrics") {
            if(!checkAuth(req)){
                return res.writeHead(401).end();
            }

            if (!TRELLO_KEY || !TRELLO_TOKEN || !BOARD_ID) {
                res.writeHead(500, {
                    "Content-Type": "text/plain; charset=utf-8",
                });
                res.end("Missing required environment variables: TRELLO_KEY, TRELLO_TOKEN, BOARD_ID.\n");
                return;
            }

            const body = await buildMetrics();
            res.writeHead(200, {
                "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
                "Cache-Control": "no-cache, no-store, must-revalidate",
                Pragma: "no-cache",
                Expires: "0",
            });
            res.end(body);
            return;
        }

        if (url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok\n");
            return;
        }

        // default 404
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found\n");
    } catch (err) {
        console.error(err);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Internal Server Error\n${err.message}\n`);
    }
});

server.listen(PORT, () => {
    console.log(`Trello Prometheus metrics server listening on http://0.0.0.0:${PORT}`);
});
