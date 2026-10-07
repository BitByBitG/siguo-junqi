#!/usr/bin/env python3
import argparse
import base64
import json
import math
import os
import random
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import requests
import torch
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from torch import nn

SEATS = ["north", "east", "south", "west"]
KINDS = ["station", "camp", "hq"]
UNKNOWN = "unknown"
EMPTY = "empty"


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def integer_bytes(value):
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


class SecureClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.http = requests.Session()
        self.channel_id = None
        self.key = None

    def establish(self):
        private = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        numbers = private.public_key().public_numbers()
        jwk = {"kty": "RSA", "n": b64url(integer_bytes(numbers.n)), "e": b64url(integer_bytes(numbers.e)),
               "alg": "RSA-OAEP-256", "ext": True, "key_ops": ["encrypt"]}
        response = self.http.post(self.base_url + "/api/crypto", json={"publicKey": jwk}, timeout=10)
        data = response.json()
        response.raise_for_status()
        raw = private.decrypt(base64.b64decode(data["key"]), padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        self.channel_id, self.key = data["id"], raw

    def request(self, method, route, token=None, body=None, timeout=10):
        for attempt in range(2):
            if self.key is None:
                self.establish()
            iv = os.urandom(12)
            plain = json.dumps({"kind": "http", "url": route, "method": method,
                                "authorization": "Bearer " + token if token else None, "body": body,
                                "time": int(time.time() * 1000), "nonce": str(uuid.uuid4())},
                               ensure_ascii=False, separators=(",", ":")).encode()
            encrypted = AESGCM(self.key).encrypt(iv, plain, b"client-v1")
            outer = self.http.post(self.base_url + "/api/secure", json={
                "id": self.channel_id, "iv": base64.b64encode(iv).decode(),
                "data": base64.b64encode(encrypted).decode()}, timeout=timeout)
            packet = outer.json()
            if "iv" not in packet:
                self.channel_id = self.key = None
                if attempt == 0:
                    continue
                raise RuntimeError(packet.get("error", "加密连接失效"))
            opened = AESGCM(self.key).decrypt(base64.b64decode(packet["iv"]),
                                               base64.b64decode(packet["data"]), b"server-v1")
            value = json.loads(opened)["value"]
            if not outer.ok:
                error = RuntimeError(value.get("error", "HTTP " + str(outer.status_code)))
                error.status = outer.status_code
                raise error
            return value


class GraphPolicyValue(nn.Module):
    def __init__(self, feature_size, hidden=128):
        super().__init__()
        self.input = nn.Linear(feature_size, hidden)
        self.message = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(3)])
        self.norm = nn.ModuleList([nn.LayerNorm(hidden) for _ in range(3)])
        self.action = nn.Sequential(nn.Linear(hidden * 3, hidden), nn.ReLU(), nn.Linear(hidden, 1))
        self.value = nn.Sequential(nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, 1), nn.Tanh())

    def forward(self, features, adjacency, actions):
        h = torch.relu(self.input(features))
        for layer, norm in zip(self.message, self.norm):
            h = norm(h + torch.relu(layer(adjacency @ h)))
        pooled = h.mean(0)
        if actions.numel():
            g = pooled.unsqueeze(0).expand(actions.shape[0], -1)
            pair = torch.cat([h[actions[:, 0]], h[actions[:, 1]], g], dim=1)
            logits = self.action(pair).squeeze(1)
        else:
            logits = torch.empty(0, device=features.device)
        return logits, self.value(pooled).squeeze(0)


class Encoder:
    def __init__(self, board, device):
        self.board, self.device = board, device
        self.nodes = board["nodes"]
        self.index = {node["id"]: i for i, node in enumerate(self.nodes)}
        self.types = list(board["pieceInfo"].keys()) + [UNKNOWN]
        self.type_index = {name: i for i, name in enumerate(self.types)}
        self.feature_size = 5 + len(self.types) + 3 + 7
        adjacency = torch.eye(len(self.nodes), dtype=torch.float32)
        for a, b in board["roads"]:
            i, j = self.index[a], self.index[b]
            adjacency[i, j] = adjacency[j, i] = 1
        degree = adjacency.sum(1).clamp_min(1).sqrt()
        self.adjacency = (adjacency / degree[:, None] / degree[None, :]).to(device)

    @staticmethod
    def relation(viewer, owner, mode):
        if owner == viewer:
            return 1
        if mode == "alliance" and (owner in ("north", "south")) == (viewer in ("north", "south")):
            return 2
        return 3

    def encode(self, state):
        n = len(self.nodes)
        x = torch.zeros((n, self.feature_size), dtype=torch.float32)
        for i, node in enumerate(self.nodes):
            x[i, 0] = 1
            x[i, 5 + len(self.types) + KINDS.index(node["kind"])] = 1
            base = 5 + len(self.types) + 3
            x[i, base:base + 2] = torch.tensor([node["x"] / 18, node["y"] / 18])
            x[i, base + 2] = float(node.get("seat") == state["viewerSeat"])
            x[i, base + 3] = float(node.get("seat") is None)
            x[i, base + 4] = float(state.get("turn") == state["viewerSeat"])
            x[i, base + 5] = min(1, state.get("noCapturePly", 0) / 16)
            x[i, base + 6] = min(1, state.get("ply", 0) / max(1, state.get("totalPlyLimit", 512)))
        for piece in state.get("pieces", []):
            if piece.get("position") not in self.index:
                continue
            i = self.index[piece["position"]]
            x[i, 0:5] = 0
            x[i, self.relation(state["viewerSeat"], piece["owner"], state["mode"])] = 1
            ptype = piece.get("type") or UNKNOWN
            x[i, 5 + self.type_index[ptype]] = 1
        return x.to(self.device)

    def actions(self, moves):
        return torch.tensor([[self.index[m["from"]], self.index[m["to"]]] for m in moves],
                            dtype=torch.long, device=self.device)


@dataclass
class GameMemory:
    code: str
    seat: str
    states: list = field(default_factory=list)
    prepared: bool = False
    last_revision: int = -1


class NeuralBot:
    def __init__(self, args):
        self.args = args
        self.device = torch.device(args.device)
        self.client = SecureClient(args.server)
        self.token = None
        self.board = None
        self.encoder = None
        self.model = None
        self.optimizer = None
        self.games = {}
        self.trained_games = 0

    def api(self, method, route, body=None):
        return self.client.request(method, route, self.token, body)

    def login(self):
        result = self.client.request("POST", "/api/bot/login", body={
            "username": self.args.username, "password": self.args.password})
        self.token = result["token"]
        self.board = self.api("GET", "/api/bot/board")
        if self.board.get("ruleset") != "siguo-custom-v1":
            raise RuntimeError("不支持服务器当前棋盘规则")
        self.encoder = Encoder(self.board, self.device)
        self.model = GraphPolicyValue(self.encoder.feature_size, self.args.hidden).to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=self.args.learning_rate, weight_decay=1e-4)
        path = Path(self.args.model)
        if path.exists():
            saved = torch.load(path, map_location=self.device, weights_only=False)
            if saved.get("nodes") != [n["id"] for n in self.encoder.nodes]:
                raise RuntimeError("模型棋盘结构与服务器不一致")
            self.model.load_state_dict(saved["model"])
            self.optimizer.load_state_dict(saved["optimizer"])
            self.trained_games = saved.get("trained_games", 0)
        print(f"已登录 {result['username']}，已训练 {self.trained_games} 局")

    def save(self):
        path = Path(self.args.model)
        temp = path.with_suffix(path.suffix + ".tmp")
        torch.save({"model": self.model.state_dict(), "optimizer": self.optimizer.state_dict(),
                    "trained_games": self.trained_games,
                    "nodes": [n["id"] for n in self.encoder.nodes]}, temp)
        temp.replace(path)

    def layout(self, state):
        own = [p for p in state["records"] if p["owner"] == state["viewerSeat"]]
        nodes = [n for n in self.encoder.nodes if n.get("seat") == state["viewerSeat"] and n["kind"] != "camp"]
        free = {n["id"] for n in nodes}
        placed = {}
        flag = next(p for p in own if p["type"] == "flag")
        hq = [n["id"] for n in nodes if n["kind"] == "hq"]
        placed[flag["id"]] = random.choice(hq)
        free.remove(placed[flag["id"]])
        for p in [p for p in own if p["type"] == "mine"]:
            choices = [v for v in free if int(v.split("-")[1]) >= 4]
            placed[p["id"]] = random.choice(choices)
            free.remove(placed[p["id"]])
        for p in [p for p in own if p["type"] == "bomb"]:
            choices = [v for v in free if int(v.split("-")[1]) >= 1]
            placed[p["id"]] = random.choice(choices)
            free.remove(placed[p["id"]])
        rest = [p for p in own if p["id"] not in placed]
        slots = list(free)
        random.shuffle(slots)
        for p, position in zip(rest, slots):
            placed[p["id"]] = position
        return [{"id": p["id"], "position": placed[p["id"]]} for p in own]

    def heuristic(self, state, move):
        by_position = {p["position"]: p for p in state.get("pieces", [])}
        attacker, defender = by_position.get(move["from"]), by_position.get(move["to"])
        target = self.board["nodes"][self.encoder.index[move["to"]]]
        source = self.board["nodes"][self.encoder.index[move["from"]]]
        score = 0.0
        if defender:
            score += 2.0
            if defender.get("type") == "flag":
                score += 30
            if target["kind"] == "hq":
                score += 4
        if target["kind"] == "camp":
            score += .5
        center = (9, 9)
        before = abs(source["x"] - center[0]) + abs(source["y"] - center[1])
        after = abs(target["x"] - center[0]) + abs(target["y"] - center[1])
        score += .08 * (before - after)
        if attacker and attacker.get("type") in ("bomb", "engineer") and not defender:
            score -= .35
        return score

    def choose(self, state, memory):
        moves = state["legalMoves"]
        features, actions = self.encoder.encode(state), self.encoder.actions(moves)
        self.model.eval()
        with torch.no_grad():
            logits, value = self.model(features, self.encoder.adjacency, actions)
            prior = torch.tensor([self.heuristic(state, m) for m in moves], device=self.device)
            neural_weight = min(1.0, self.trained_games / max(1, self.args.warmup_games))
            combined = neural_weight * logits + prior
            if self.args.inference_only:
                choice = int(combined.argmax())
            else:
                distribution = torch.distributions.Categorical(logits=combined / self.args.temperature)
                choice = int(distribution.sample())
        if not self.args.inference_only:
            memory.states.append({"state": state, "moves": moves, "choice": choice})
        print(f"{state['code']} {state['viewerSeat']} value={float(value):+.3f} "
              f"{moves[choice]['from']} -> {moves[choice]['to']}")
        return moves[choice]

    @staticmethod
    def won(state):
        if state.get("drawn"):
            return 0.0
        living = set(state.get("livingSeats", []))
        seat = state["viewerSeat"]
        if state["mode"] == "alliance":
            allies = {s for s in SEATS if (s in ("north", "south")) == (seat in ("north", "south"))}
            return 1.0 if living & allies else -1.0
        return 1.0 if seat in living else -1.0

    def train_game(self, memory, result):
        if self.args.inference_only or not memory.states:
            return
        reward = self.won(result)
        self.model.train()
        for _ in range(self.args.epochs):
            losses = []
            total = len(memory.states)
            for step, item in enumerate(memory.states):
                features = self.encoder.encode(item["state"])
                actions = self.encoder.actions(item["moves"])
                logits, value = self.model(features, self.encoder.adjacency, actions)
                target = reward * (self.args.discount ** (total - step - 1))
                advantage = torch.tensor(target, device=self.device) - value.detach()
                log_prob = torch.log_softmax(logits, 0)[item["choice"]]
                entropy = -(torch.softmax(logits, 0) * torch.log_softmax(logits, 0)).sum()
                losses.append(-log_prob * advantage + .5 * (value - target) ** 2 - .01 * entropy)
            self.optimizer.zero_grad()
            torch.stack(losses).mean().backward()
            nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
            self.optimizer.step()
        self.trained_games += 1
        self.save()
        print(f"{memory.code}/{memory.seat} 训练完成，结果 {reward:+.0f}，累计 {self.trained_games} 局")

    def submit(self, state, action, **payload):
        body = {**payload, "assignmentId": state["assignmentId"], "revision": state["revision"],
                "requestId": str(uuid.uuid4())}
        return self.api("POST", f"/api/bot/rooms/{state['code']}/{action}", body)

    def process(self, assignment):
        key = assignment["assignmentId"]
        memory = self.games.setdefault(key, GameMemory(assignment["code"], assignment["seat"]))
        route = f"/api/bot/rooms/{assignment['code']}?assignmentId={key}"
        state = self.api("GET", route)
        if state["phase"] == "finished":
            self.train_game(memory, state)
            self.games.pop(key, None)
            return True
        offer = state.get("drawOffer")
        if offer and state["viewerSeat"] not in offer.get("accepted", []):
            self.submit(state, "draw", accept=False, offerId=offer["id"])
            return False
        if state["phase"] == "setup" and not state["ready"]:
            if not memory.prepared:
                self.submit(state, "setup", pieces=self.layout(state))
                memory.prepared = True
                state = self.api("GET", route)
            self.submit(state, "ready", ready=True)
            return False
        if state["phase"] == "playing" and state["turn"] == state["viewerSeat"] and state["legalMoves"]:
            if state["revision"] == memory.last_revision:
                return
            memory.last_revision = state["revision"]
            move = self.choose(state, memory)
            self.submit(state, "move", **move)
        return False

    def run(self):
        self.login()
        known = {}
        while True:
            try:
                session = self.api("GET", "/api/bot/session")
                active = {a["assignmentId"]: a for a in session.get("assignments", [])}
                for key, assignment in active.items():
                    known[key] = assignment
                    if self.process(assignment):
                        known.pop(key, None)
                for key, assignment in list(known.items()):
                    if key in active:
                        continue
                    try:
                        if self.process(assignment):
                            known.pop(key, None)
                    except RuntimeError as error:
                        if getattr(error, "status", None) in (403, 404, 409):
                            self.games.pop(key, None)
                            known.pop(key, None)
                        else:
                            raise
                time.sleep(self.args.poll)
            except KeyboardInterrupt:
                print("已停止")
                return
            except RuntimeError as error:
                if getattr(error, "status", None) == 401:
                    self.token = None
                    self.login()
                else:
                    print("错误：", error)
                    time.sleep(1)


def parse_args():
    parser = argparse.ArgumentParser(description="四国军棋 PyTorch 图神经网络 BOT")
    parser.add_argument("--server", default=os.getenv("BOT_SERVER", "http://localhost:3000"))
    parser.add_argument("--username", default=os.getenv("BOT_USERNAME"))
    parser.add_argument("--password", default=os.getenv("BOT_PASSWORD"))
    parser.add_argument("--model", default="model.pt")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--temperature", type=float, default=.9)
    parser.add_argument("--discount", type=float, default=.997)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--warmup-games", type=int, default=200)
    parser.add_argument("--poll", type=float, default=.15)
    parser.add_argument("--inference-only", action="store_true")
    args = parser.parse_args()
    if not args.username or not args.password:
        parser.error("请设置 BOT_USERNAME 和 BOT_PASSWORD")
    return args


if __name__ == "__main__":
    NeuralBot(parse_args()).run()
