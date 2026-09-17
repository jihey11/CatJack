function normalizeBet(value) {
  const bet = Math.floor(Number(value) / 10) * 10;
  return Number.isFinite(bet) ? Math.max(10, bet) : 10;
}

function cardScore(cards = []) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card?.value === "ACE") {
      total += 11;
      aces += 1;
    } else if (["KING", "QUEEN", "JACK"].includes(card?.value)) {
      total += 10;
    } else {
      total += Number(card?.value || 0);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function isBlackjack(cards = []) {
  return cards.length === 2 && cardScore(cards) === 21;
}

function compactCard(card) {
  return card ? { code: card.code, value: card.value, suit: card.suit } : null;
}

async function createDeck() {
  const response = await fetch("https://deckofcardsapi.com/api/deck/new/shuffle/?deck_count=1");
  if (!response.ok) throw new Error("Deck of Cards API 덱 생성 실패");
  const data = await response.json();
  if (!data.success || !data.deck_id) throw new Error("Deck of Cards API 응답 오류");
  return data.deck_id;
}

async function drawCards(deckId, count) {
  const response = await fetch(`https://deckofcardsapi.com/api/deck/${encodeURIComponent(deckId)}/draw/?count=${count}`);
  if (!response.ok) throw new Error("Deck of Cards API 카드 뽑기 실패");
  const data = await response.json();
  if (!data.success || !Array.isArray(data.cards) || data.cards.length !== count) {
    throw new Error("Deck of Cards API 카드 수량 오류");
  }
  return data.cards;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  normalizeBet,
  cardScore,
  isBlackjack,
  compactCard,
  createDeck,
  drawCards,
  delay
};
