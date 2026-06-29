// Server-side mirror of well-collective-app/src/utils/recipePhotos.ts —
// needed here so the diversify-photos admin tool can pick from the same
// pools the client would otherwise resolve to via hash, but explicitly
// avoiding photos already assigned to other recent recipes.
const u = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=70`;

export const PHOTOS: Record<string, string[]> = {
  salad: [
    u("photo-1512621776951-a57141f2eefd"),
    u("photo-1540420773420-3366772f4999"),
    u("photo-1546069901-ba9599a7e63c"),
  ],
  grain_bowl: [
    u("photo-1590301157890-4810ed352733"),
    u("photo-1604909052743-94e838986d24"),
    u("photo-1520066391310-428f06ebd602"),
  ],
  smoothie: [
    u("photo-1502741338009-cac2772e18bc"),
    u("photo-1553530666-ba11a7da3888"),
    u("photo-1638176066666-ffb2f013c7dd"),
  ],
  smoothie_bowl: [u("photo-1590301157890-4810ed352733"), u("photo-1546069901-ba9599a7e63c")],
  soup_asian: [u("photo-1680137248903-7af5d51a3350"), u("photo-1652088079703-38f4a8d6b981")],
  soup_creamy: [
    u("photo-1604152135912-04a022e23696"),
    u("photo-1613844237701-8f3664fc2eff"),
    u("photo-1476718406336-bb5a9690ee2a"),
  ],
  soup_brothy: [
    u("photo-1643786661490-966f1877effa"),
    u("photo-1584972922016-912db9f3df22"),
    u("photo-1605880980331-20a711b27338"),
  ],
  soup: [
    u("photo-1476718406336-bb5a9690ee2a"),
    u("photo-1588566565463-180a5b2090d2"),
    u("photo-1643786661490-966f1877effa"),
  ],
  pasta: [
    u("photo-1621996346565-e3dbc646d9a9"),
    u("photo-1473093295043-cdd812d0e601"),
    u("photo-1563379926898-05f4575a45d8"),
  ],
  noodles_asian: [u("photo-1559314809-0d155014e29e"), u("photo-1637806930600-37fa8892069d")],
  chicken: [
    u("photo-1532550907401-a500c9a57435"),
    u("photo-1598515214211-89d3c73ae83b"),
    u("photo-1604908176997-125f25cc6f3d"),
  ],
  fish: [
    u("photo-1467003909585-2f8a72700288"),
    u("photo-1519708227418-c8fd9a32b7a2"),
    u("photo-1580476262798-bddd9f4b7369"),
  ],
  salmon: [
    u("photo-1519708227418-c8fd9a32b7a2"),
    u("photo-1560717845-968823efbee1"),
    u("photo-1580476262798-bddd9f4b7369"),
  ],
  shrimp: [
    u("photo-1625943553852-781c6dd46faa"),
    u("photo-1579783411296-c908953b2dcd"),
    u("photo-1619810815691-4766cd4b8054"),
  ],
  sushi: [
    u("photo-1579584425555-c3ce17fd4351"),
    u("photo-1579871494447-9811cf80d66c"),
    u("photo-1615361200141-f45040f367be"),
  ],
  oatmeal: [
    u("photo-1517673400267-0251440c45dc"),
    u("photo-1495214783159-3503fd1b572d"),
    u("photo-1497888329096-51c27beff665"),
    u("photo-1574484284002-952d92456975"),
    u("photo-1517093157656-b9eccef91cb1"),
    u("photo-1517248135467-4c7edcad34c4"),
  ],
  chia_pudding: [
    u("photo-1552528352-59648b345866"),
    u("photo-1490474504059-bf2db5ab2348"),
    u("photo-1551464728-71450ca29a0d"),
  ],
  overnight_oats: [
    u("photo-1681150405668-cd5b2a37195d"),
    u("photo-1638777742192-3cccddaea89f"),
    u("photo-1497888329096-51c27beff665"),
  ],
  toast: [
    u("photo-1484723091739-30a097e8f929"),
    u("photo-1525351484163-7529414344d8"),
    u("photo-1533089860892-a7c6f0a88666"),
  ],
  avocado_toast: [
    u("photo-1603046891726-36bfd957e0bf"),
    u("photo-1588137378633-dea1336ce1e2"),
    u("photo-1525351484163-7529414344d8"),
  ],
  wrap: [u("photo-1626700051175-6818013e1d4f"), u("photo-1551326844-4df70f78d0e9")],
  rice: [u("photo-1516684732162-798a0062be99"), u("photo-1536304993881-ff6e9eefa2a6")],
  stir_fry: [
    u("photo-1603133872878-684f208fb84b"),
    u("photo-1512058564366-18510be2db19"),
    u("photo-1559314809-0d155014e29e"),
  ],
  roasted_vegetables: [u("photo-1636743716922-1884c23fb6f6"), u("photo-1596464716059-f81da526557b")],
  curry: [u("photo-1565557623262-b51c2513a641"), u("photo-1588166524941-3bf61a9c41db")],
  tacos: [u("photo-1551504734-5ee1c4a1479b"), u("photo-1565299585323-38d6b0865b47")],
  burrito_bowl: [
    u("photo-1668665771757-4d42737d295a"),
    u("photo-1533606117812-0783e8e690f1"),
    u("photo-1520066391310-428f06ebd602"),
  ],
  sandwich: [u("photo-1528735602780-2552fd46c7af"), u("photo-1553909489-cd47e0907980")],
  fruit: [u("photo-1490474418585-ba9bad8fd0ea"), u("photo-1488459716781-31db52582fe9")],
  baked: [
    u("photo-1509440159596-0249088772ff"),
    u("photo-1495147466023-ac5c588e2e94"),
    u("photo-1493770348161-369560ae357d"),
    u("photo-1607532941433-304659e8198a"),
  ],
  dessert: [u("photo-1565958011703-44f9829ba187"), u("photo-1488477181946-6428a0291777")],
  flatbread: [u("photo-1588315029754-2dd089d39a1a"), u("photo-1584365685547-9a5fb6f3a70c")],
  energy_balls: [u("photo-1596723455658-72ebb0d12edd"), u("photo-1678554500191-3885a6fbf8c2")],
  stuffed_vegetables: [
    u("photo-1596464716059-f81da526557b"),
    u("photo-1673646960062-9aeb2188335f"),
    u("photo-1592119747782-d8c12c2ea267"),
  ],
  lentil: [u("photo-1510431198580-7727c9fa1e3a"), u("photo-1605909388460-74ec8b204127")],
  mediterranean: [
    u("photo-1593001872095-7d5b3868fb1d"),
    u("photo-1680990999782-ba7fe26e4d0b"),
    u("photo-1547058881-aa0edd92aab3"),
  ],
  general_healthy: [
    u("photo-1546069901-ba9599a7e63c"),
    u("photo-1512621776951-a57141f2eefd"),
    u("photo-1502741338009-cac2772e18bc"),
    u("photo-1517673400267-0251440c45dc"),
    u("photo-1540420773420-3366772f4999"),
    u("photo-1547592180-85f173990554"),
  ],
};

const MATCHERS: [string[], string][] = [
  [["miso", "ramen", "pho", "wonton", "udon", "soba", "dashi", "tom yum", "tom kha", "hot and sour", "egg drop"], "soup_asian"],
  [["bisque", "puree", "pureed", "cream of", "creamy soup", "pumpkin soup", "butternut soup", "tomato soup", "potato soup", "cauliflower soup", "carrot soup", "squash soup"], "soup_creamy"],
  [["minestrone", "vegetable soup", "chicken soup", "tortilla soup", "bean soup", "barley soup"], "soup_brothy"],
  [["soup", "broth", "stew", "chili", "chowder", "gazpacho"], "soup"],
  [["salmon", "smoked salmon"], "salmon"],
  [["shrimp", "prawn", "scallop", "crab", "lobster", "calamari"], "shrimp"],
  [["sushi", "sashimi", "poke", "poke bowl", "maki", "nigiri", "temaki"], "sushi"],
  [["fish", "tuna", "cod", "tilapia", "mahi", "halibut", "trout", "sea bass", "snapper"], "fish"],
  [["chicken", "turkey", "poultry", "hen"], "chicken"],
  [["burrito bowl", "buddha bowl", "power bowl", "chipotle", "tex-mex bowl"], "burrito_bowl"],
  [["acai", "smoothie bowl", "pitaya bowl", "dragon fruit bowl"], "smoothie_bowl"],
  [["chia pudding", "chia seed"], "chia_pudding"],
  [["overnight oats", "overnight"], "overnight_oats"],
  [["avocado toast", "avo toast"], "avocado_toast"],
  [["falafel", "hummus", "shawarma", "tahini", "tabbouleh", "baba ganoush", "pita", "greek", "mediterranean", "tzatziki"], "mediterranean"],
  [["pad thai", "lo mein", "chow mein", "yakisoba", "rice noodle", "glass noodle", "dan dan", "laksa", "japchae"], "noodles_asian"],
  [["naan", "flatbread", "pita pizza", "naan pizza", "focaccia"], "flatbread"],
  [["stuffed pepper", "stuffed tomato", "stuffed squash", "stuffed mushroom", "stuffed zucchini", "stuffed eggplant"], "stuffed_vegetables"],
  [["energy ball", "energy bite", "protein ball", "protein bite", "bliss ball", "date ball"], "energy_balls"],
  [["lentil", "dal", "daal", "dhal", "bean stew", "chickpea stew", "black bean soup", "white bean"], "lentil"],
  [["porridge", "oatmeal", "oats", "granola", "muesli"], "oatmeal"],
  [["smoothie", "shake", "blend", "juice"], "smoothie"],
  [["salad", "slaw", "greens", "arugula", "kale salad", "lettuce", "chopped"], "salad"],
  [["curry", "tikka", "masala", "korma", "vindaloo"], "curry"],
  [["pasta", "spaghetti", "penne", "linguine", "fettuccine", "ziti", "macaroni", "lasagna", "gnocchi"], "pasta"],
  [["noodle", "ramen noodle"], "noodles_asian"],
  [["stir fry", "stir-fry", "wok", "teriyaki"], "stir_fry"],
  [["taco", "burrito", "enchilada", "fajita", "quesadilla"], "tacos"],
  [["toast", "bruschetta", "crostini"], "toast"],
  [["wrap", "roll-up", "roll up", "spring roll", "lettuce wrap", "collard wrap"], "wrap"],
  [["sandwich", "panini", "club", "sub", "melt", "blt"], "sandwich"],
  [["rice", "risotto", "pilaf", "fried rice", "quinoa", "grain bowl"], "grain_bowl"],
  [["roast", "roasted", "baked vegeta", "sheet pan"], "roasted_vegetables"],
  [["cake", "cookie", "brownie", "dessert", "sweet", "chocolate", "parfait", "pudding", "mousse", "ice cream"], "dessert"],
  [["fruit", "berry", "melon", "citrus", "tropical"], "fruit"],
  [["muffin", "scone", "bread", "baked", "banana bread"], "baked"],
  [["egg", "omelet", "omelette", "frittata", "scramble", "breakfast"], "toast"],
];

export function resolveCategory(name: string, ingredients: string[], imageCategory?: string): string {
  if (imageCategory && PHOTOS[imageCategory]) return imageCategory;
  const text = `${name} ${ingredients.join(" ")}`.toLowerCase();
  for (const [keywords, category] of MATCHERS) {
    if (keywords.some((kw) => text.includes(kw))) return category;
  }
  return "general_healthy";
}
