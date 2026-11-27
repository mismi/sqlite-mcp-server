/**
 * Creates the demo database used by the examples and the evaluations.
 *
 * Run with: bun run seed  (or: bun scripts/seed.ts)
 * Overwrite the location with SQLITE_DB_PATH.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_DB_PATH } from "../src/constants.js";

const target = process.env.SQLITE_DB_PATH ? resolve(process.cwd(), process.env.SQLITE_DB_PATH) : DEFAULT_DB_PATH;

mkdirSync(dirname(target), { recursive: true });
rmSync(target, { force: true });

const db = new DatabaseSync(target);
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE authors (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  country   TEXT NOT NULL,
  born      INTEGER NOT NULL
);

CREATE TABLE books (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  author_id  INTEGER NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
  genre      TEXT NOT NULL,
  published  INTEGER NOT NULL,
  price      REAL NOT NULL CHECK (price >= 0),
  stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE customers (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  city    TEXT NOT NULL,
  country TEXT NOT NULL,
  joined  TEXT NOT NULL
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  ordered_at  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'cancelled')),
  total       REAL NOT NULL DEFAULT 0
);

CREATE INDEX idx_books_author ON books(author_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_book ON orders(book_id);

CREATE VIEW sales_by_book AS
SELECT
  b.id                       AS book_id,
  b.title                    AS title,
  a.name                     AS author,
  COALESCE(SUM(o.quantity), 0) AS copies_sold,
  ROUND(COALESCE(SUM(o.total), 0), 2) AS revenue
FROM books b
JOIN authors a ON a.id = b.author_id
LEFT JOIN orders o ON o.book_id = b.id AND o.status = 'delivered'
GROUP BY b.id;
`);

const authors: [number, string, string, number][] = [
  [1, "Ursula K. Le Guin", "United States", 1929],
  [2, "Jorge Luis Borges", "Argentina", 1899],
  [3, "Chimamanda Ngozi Adichie", "Nigeria", 1977],
  [4, "Haruki Murakami", "Japan", 1949],
  [5, "Italo Calvino", "Italy", 1923],
  [6, "Toni Morrison", "United States", 1931]
];

const books: [number, string, number, string, number, number, number][] = [
  [1, "A Wizard of Earthsea", 1, "fantasy", 1968, 9.99, 42],
  [2, "The Left Hand of Darkness", 1, "science fiction", 1969, 12.5, 18],
  [3, "The Dispossessed", 1, "science fiction", 1974, 13.0, 7],
  [4, "Ficciones", 2, "short stories", 1944, 11.25, 25],
  [5, "The Aleph", 2, "short stories", 1949, 10.0, 12],
  [6, "Labyrinths", 2, "short stories", 1962, 14.75, 5],
  [7, "Half of a Yellow Sun", 3, "historical fiction", 2006, 15.99, 31],
  [8, "Americanah", 3, "fiction", 2013, 14.5, 60],
  [9, "Purple Hibiscus", 3, "fiction", 2003, 12.99, 22],
  [10, "Norwegian Wood", 4, "fiction", 1987, 13.99, 38],
  [11, "Kafka on the Shore", 4, "magical realism", 2002, 16.0, 14],
  [12, "1Q84", 4, "magical realism", 2009, 21.5, 9],
  [13, "If on a winter's night a traveler", 5, "fiction", 1979, 13.25, 16],
  [14, "Invisible Cities", 5, "fiction", 1972, 11.0, 27],
  [15, "The Baron in the Trees", 5, "fiction", 1957, 10.75, 3],
  [16, "Beloved", 6, "historical fiction", 1987, 13.5, 20],
  [17, "Song of Solomon", 6, "fiction", 1977, 12.25, 11],
  [18, "Sula", 6, "fiction", 1973, 9.5, 34],
  [19, "Tales from Earthsea", 1, "fantasy", 2001, 12.0, 8],
  [20, "After Dark", 4, "fiction", 2004, 11.75, 19],
  [21, "The Nonexistent Knight", 5, "fiction", 1959, 10.5, 6],
  [22, "Jazz", 6, "fiction", 1992, 11.5, 26]
];

const customers: [number, string, string, string, string][] = [
  [1, "Maya Patel", "Austin", "United States", "2023-01-14"],
  [2, "Liam O'Connor", "Dublin", "Ireland", "2023-03-02"],
  [3, "Sofia Rossi", "Milan", "Italy", "2023-04-19"],
  [4, "Kenji Watanabe", "Tokyo", "Japan", "2023-06-25"],
  [5, "Amara Okafor", "Lagos", "Nigeria", "2023-08-08"],
  [6, "Elena Garcia", "Madrid", "Spain", "2024-01-05"],
  [7, "Noah Fischer", "Berlin", "Germany", "2024-02-17"],
  [8, "Priya Nair", "Bengaluru", "India", "2024-05-23"],
  [9, "Lucas Silva", "Sao Paulo", "Brazil", "2024-09-11"],
  [10, "Hannah Lee", "Seoul", "South Korea", "2025-01-30"]
];

const orders: [number, number, number, number, string, string][] = [
  [1, 1, 8, 2, "2024-02-03", "delivered"],
  [2, 1, 1, 1, "2024-03-11", "delivered"],
  [3, 2, 16, 1, "2024-03-15", "delivered"],
  [4, 3, 13, 1, "2024-04-02", "delivered"],
  [5, 3, 14, 3, "2024-04-02", "delivered"],
  [6, 4, 12, 1, "2024-04-21", "cancelled"],
  [7, 4, 10, 2, "2024-05-06", "delivered"],
  [8, 5, 7, 1, "2024-05-18", "delivered"],
  [9, 5, 9, 2, "2024-06-01", "delivered"],
  [10, 6, 2, 1, "2024-06-14", "delivered"],
  [11, 7, 11, 1, "2024-07-09", "delivered"],
  [12, 8, 4, 1, "2024-07-23", "delivered"],
  [13, 8, 18, 2, "2024-07-23", "delivered"],
  [14, 9, 8, 1, "2024-08-04", "delivered"],
  [15, 1, 20, 1, "2024-08-19", "delivered"],
  [16, 2, 3, 1, "2024-09-02", "delivered"],
  [17, 10, 12, 2, "2024-09-17", "pending"],
  [18, 3, 16, 1, "2024-10-05", "delivered"],
  [19, 6, 5, 1, "2024-10-22", "delivered"],
  [20, 7, 8, 3, "2024-11-08", "delivered"],
  [21, 4, 11, 1, "2024-11-29", "delivered"],
  [22, 9, 1, 2, "2024-12-12", "delivered"],
  [23, 5, 7, 1, "2025-01-06", "delivered"],
  [24, 8, 14, 2, "2025-01-27", "delivered"],
  [25, 10, 10, 1, "2025-02-14", "delivered"],
  [26, 2, 17, 1, "2025-03-03", "delivered"],
  [27, 6, 13, 1, "2025-03-21", "delivered"],
  [28, 3, 15, 2, "2025-04-09", "cancelled"],
  [29, 1, 8, 1, "2025-04-28", "delivered"],
  [30, 9, 19, 1, "2025-05-15", "delivered"],
  [31, 7, 2, 1, "2025-06-01", "delivered"],
  [32, 5, 9, 1, "2025-06-20", "pending"],
  [33, 4, 6, 1, "2025-07-07", "delivered"],
  [34, 10, 7, 1, "2025-07-25", "delivered"]
];

db.exec("BEGIN");
const insertAuthor = db.prepare("INSERT INTO authors (id, name, country, born) VALUES (?, ?, ?, ?)");
const insertBook = db.prepare(
  "INSERT INTO books (id, title, author_id, genre, published, price, stock) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const insertCustomer = db.prepare("INSERT INTO customers (id, name, city, country, joined) VALUES (?, ?, ?, ?, ?)");
const insertOrder = db.prepare(
  "INSERT INTO orders (id, customer_id, book_id, quantity, ordered_at, status) VALUES (?, ?, ?, ?, ?, ?)"
);

for (const row of authors) insertAuthor.run(...row);
for (const row of books) insertBook.run(...row);
for (const row of customers) insertCustomer.run(...row);
for (const row of orders) insertOrder.run(...row);

// Order totals are derived from the book price so the data stays consistent.
db.exec(`
  UPDATE orders
  SET total = ROUND(quantity * (SELECT price FROM books WHERE books.id = orders.book_id), 2)
`);
db.exec("COMMIT");

const counts = db
  .prepare(
    `SELECT 'authors' AS name, COUNT(*) AS n FROM authors
     UNION ALL SELECT 'books', COUNT(*) FROM books
     UNION ALL SELECT 'customers', COUNT(*) FROM customers
     UNION ALL SELECT 'orders', COUNT(*) FROM orders`
  )
  .all() as { name: string; n: number }[];

console.error(`Seeded ${target}`);
for (const row of counts) console.error(`  ${row.name}: ${row.n} rows`);
db.close();
