const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require('mongodb');
require("dotenv").config();


const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.xkximz0.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

     const workersCollection = client.db("workersDb").collection("allWorkers");
     const usersCollection = client.db("allUsersDb").collection("allUsers");

app.post("/allUsers", async (req, res) => {
  const user = req.body;
  const result = await usersCollection.insertOne(user);
  res.status(201).json(result);
});
app.post("/allWorkers", async (req, res) => {
  const user = req.body;
  const result = await workersCollection.insertOne(user);
  res.status(201).json(result);
});

 app.get("/allUsers", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

   app.get("/best-workers", async (req, res) => {
    const bestWorkers = await workersCollection
      .find({ role: "worker" })
      .sort({ coins: -1 }) // sort descending
      .limit(6)
      .toArray();
    res.send(bestWorkers);
});



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Looking for money in server..!");
});

app.listen(port, () => {
  console.log(`WorkNest server is running on port ${port}`);
});
