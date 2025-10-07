const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dotenv = require("dotenv");
const Stripe = require("stripe");
const admin = require("firebase-admin");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const http = require("http");
const { Server } = require("socket.io");
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_KEY, "base64").toString("utf8")
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const adminEmail = process.env.ADMIN_EMAIL;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.xkximz0.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const workersCollection = client
      .db("bestWorkersDb")
      .collection("bestWorkers");
    const usersCollection = client.db("allUsersDb").collection("allUsers");
    const tasksCollection = client.db("allTasksDB").collection("allTasks");
    const subCollection = client.db("submissionDB").collection("allSubmits");
    const reportsCollection = client.db("reportsDB").collection("allReports");
    const withdrawCollection = client
      .db("withdrawDB")
      .collection("allWithdraws");
    const paymentsCollection = client.db("paymentsDb").collection("payments");
    const notificationsCollection = client
      .db("notificationsDb")
      .collection("notifications");

    // ......................................!.............................................

    io.on("connection", (socket) => {
      socket.on("join", (email) => {
        // console.log(`${email} joined`);
        socket.join(email);
      });

      socket.on("disconnect", () => {
        // console.log("User disconnected:", socket.id);
      });
    });
    const createNotification = async ({ message, toEmail, actionRoute }) => {
      const notification = {
        message,
        toEmail,
        actionRoute,
        time: new Date(),
        read: false,
      };

      await notificationsCollection.insertOne(notification);
      setTimeout(async () => {
        const clients = await io.in(toEmail).fetchSockets();
        if (clients.length > 0) {
          io.to(toEmail).emit("new_notification", notification);
        }
      }, 50);

      return notification;
    };

    // ........................Verify Token,Role............................................

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      // console.log(token);

      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    const verifyRoles = (roles) => {
      return async (req, res, next) => {
        const email = req.decoded?.email;
        if (!email) return res.status(401).json({ message: "Unauthorized" });

        const user = await usersCollection.findOne({ email });
        if (!user || !roles.includes(user.role)) {
          return res.status(403).json({ message: "Forbidden access" });
        }

        req.user = user;

        next();
      };
    };
    // .................................!................................................

    // ..............................All Post..............................................

    app.post("/allUsers", async (req, res) => {
      try {
        const user = req.body;
        // console.log(user);

        const existingUser = await usersCollection.findOne({
          email: user.email,
        });

        if (existingUser) {
          const result = await usersCollection.updateOne(
            { email: user.email },
            { $set: { last_log_in: new Date().toISOString() } }
          );
          res.status(200).json({ message: "User updated", result });
        } else {
          const result = await usersCollection.insertOne(user);

          await createNotification({
            message: `🎉 Congratulations ${
              user.name
            }! Your account has been created. You got ${
              user.coins || 10
            } coins!`,
            toEmail: user.email,
            actionRoute: "/dashboard",
          });

          res.status(201).json({ message: "New user created", result });
        }
      } catch (err) {
        // console.error("Error creating/updating user:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.post("/allTasks", async (req, res) => {
      try {
        const tasksCollection = client.db("allTasksDB").collection("allTasks");
        const usersCollection = client.db("allUsersDb").collection("allUsers");
        const taskData = req.body;

        const buyer = await usersCollection.findOne({
          email: taskData.buyer_email,
        });
        if (!buyer) return res.status(404).send({ message: "User not found" });

        const total_payable_amount =
          Number(taskData.required_workers) * Number(taskData.payable_amount);

        if (buyer.coins < total_payable_amount) {
          return res.status(400).send({ message: "Insufficient coins" });
        }

        // Deduct coins
        await usersCollection.updateOne(
          { email: taskData.buyer_email },
          { $inc: { coins: -total_payable_amount } }
        );

        const newTask = {
          ...taskData,
          required_workers: Number(taskData.required_workers),
          currently_required_workers: Number(taskData.required_workers),
          payable_amount: Number(taskData.payable_amount),
          total_payable_amount,
          added_By: taskData.added_By,
        };

        const result = await tasksCollection.insertOne(newTask);
        res.send(result);
      } catch (error) {
        // console.error(error);
        res.status(500).send({ message: "Failed to add task" });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body;
        if (!amount || amount <= 0) {
          return res.status(400).json({ error: "Invalid amount" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        // console.error("Stripe create-payment-intent error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/save-payment", async (req, res) => {
      try {
        const { paid_by, email, price, transactionId, packageName, coins } =
          req.body;

        const usersCollection = client.db("allUsersDb").collection("allUsers");
        const paymentsCollection = client
          .db("paymentsDb")
          .collection("payments");

        const paymentData = {
          type_of_payment: "made",
          paid_by,
          email,
          packageName,
          price,
          coins,
          transactionId,
          date: new Date(),
        };

        const result = await paymentsCollection.insertOne(paymentData);

        await usersCollection.updateOne(
          { email },
          { $inc: { coins } },
          { upsert: true }
        );

        await createNotification({
          message: `🎉 Congrats ${paid_by}, you have successfully purchased ${coins} coins with $${price}!`,
          toEmail: email,
          actionRoute: "/dashboard/worker-home",
        });

        res.json({ success: true, result });
      } catch (error) {
        // console.error("Save payment error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post(
      "/submissions/approve/:id",
      verifyFBToken,
      verifyRoles(["buyer"]),
      async (req, res) => {
        const submissionId = req.params.id;

        try {
          const submission = await subCollection.findOne({
            _id: new ObjectId(submissionId),
          });
          if (!submission)
            return res.status(404).json({ message: "Submission not found" });

          const paymentData = {
            payment_type: "give",
            worker_name: submission.worker_name,
            task_title: submission.task_title,
            coins: submission.payable_amount,
            submission_date: submission.current_date,
            approval_date: new Date(),
            task_id: submission.task_id,
            worker_email: submission.worker_email,

            buyer_name: submission.buyer_name,

            buyer_email: submission.buyer_email,
          };
          await paymentsCollection.insertOne(paymentData);

          await usersCollection.updateOne(
            { email: submission.worker_email },
            { $inc: { coins: submission.payable_amount } }
          );

          await subCollection.updateOne(
            { _id: new ObjectId(submissionId) },
            { $set: { status: "approved" } }
          );

          await createNotification({
            message: `You earned ${submission.payable_amount} coins from ${submission.buyer_name} for completing ${submission.task_title}`,
            toEmail: submission.worker_email,
            actionRoute: "/dashboard",
          });

          res.status(200).json({ message: "Submission approved successfully" });
        } catch (err) {
          // console.error(err);
          res.status(500).json({ message: "Approval failed" });
        }
      }
    );

    app.post("/allSubmits", async (req, res) => {
      try {
        const submission = req.body;

        const submissionData = {
          ...submission,
          current_date: new Date(),
          status: "pending",
        };

        const result = await subCollection.insertOne(submissionData);

        await tasksCollection.updateOne(
          { _id: new ObjectId(submission.task_id) },
          { $inc: { currently_required_workers: -1 } }
        );

        const task = await tasksCollection.findOne({
          _id: new ObjectId(submission.task_id),
        });

        if (task) {
          await createNotification({
            message: `${submission.worker_name} submitted work for your task "${task.task_title}"`,
            toEmail: task.buyer_email,
            actionRoute: "/dashboard",
          });
        }

        res.json({ success: true, result });
      } catch (error) {
        // console.error("Error saving submission:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post("/withdrawals", async (req, res) => {
      try {
        const {
          worker_email,
          worker_name,
          withdrawal_coin,
          withdrawal_amount,
          payment_system,
          account_number,
        } = req.body;

        if (
          !worker_email ||
          !withdrawal_coin ||
          !withdrawal_amount ||
          !payment_system ||
          !account_number
        ) {
          return res.status(400).json({ message: "All fields are required" });
        }

        const withdrawal = {
          worker_email,
          worker_name,
          withdrawal_coin,
          withdrawal_amount,
          payment_system,
          account_number,
          withdraw_date: new Date(),
          status: "pending",
        };

        const result = await withdrawCollection.insertOne(withdrawal);

        await createNotification({
          message: `${worker_name} requested a withdrawal of ${withdrawal_coin} coins`,
          toEmail: adminEmail,
          actionRoute: "/dashboard",
        });

        res.json({ success: true, insertedId: result.insertedId });
      } catch (err) {
        // console.error(err);
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post("/reports", async (req, res) => {
      try {
        const {
          task_id,
          task_title,
          buyer_name,
          buyer_email,
          reported_by,
          reported_by_name,
          reason,
        } = req.body;

        const report = {
          task_id,
          task_title,
          buyer_name,
          buyer_email,
          reported_by,
          reported_by_name,
          reason,
          report_date: new Date(),
        };

        const result = await reportsCollection.insertOne(report);

        
        await createNotification({
          message: `${reported_by_name} reported the task "${task_title}"`,
          toEmail: adminEmail,
          actionRoute: "/dashboard/manage-task",
        });

        res.json({ success: true, insertedId: result.insertedId });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // ................................!....................................................

    //...............................All Put...............................................

    app.put("/allTasks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { task_title, task_detail, currently_required_workers } =
          req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid task ID" });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) return res.status(404).json({ message: "Task not found" });

        const user = await usersCollection.findOne({ email: task.buyer_email });
        if (!user) return res.status(404).json({ message: "User not found" });

        const oldRequiredWorkers = Number(task.required_workers || 0);
        const oldCurrentlyRequired = Number(
          task.currently_required_workers || 0
        );
        const payablePerWorker = Number(task.payable_amount || 0);
        const oldTotalPayable = Number(task.total_payable_amount || 0);

        const submittedWorkers = oldRequiredWorkers - oldCurrentlyRequired;

        const desiredCurrentlyRequired = Number(
          currently_required_workers || oldCurrentlyRequired
        );
        const newRequiredWorkers = submittedWorkers + desiredCurrentlyRequired;

        const workerDiff = newRequiredWorkers - oldRequiredWorkers;
        const newTotalPayable = newRequiredWorkers * payablePerWorker;
        const coinDiff = newTotalPayable - oldTotalPayable;

        if (coinDiff > 0 && user.coins < coinDiff) {
          return res.status(400).json({ message: "Insufficient coins" });
        }

        const updateData = {
          task_title,
          task_detail,
          currently_required_workers: desiredCurrentlyRequired,
          total_payable_amount: newTotalPayable,
        };

        await tasksCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: updateData,
            $inc: { required_workers: workerDiff },
          }
        );

        if (coinDiff !== 0) {
          await usersCollection.updateOne(
            { email: task.buyer_email },
            { $inc: { coins: -coinDiff } }
          );
        }

        res.json({
          success: true,
          message: "Task updated successfully",
          updated: updateData,
          coinsChanged: coinDiff,
          workerChanged: workerDiff,
        });
      } catch (error) {
        // console.error("Error updating task:", error);
        res.status(500).json({ message: "Failed to update task" });
      }
    });

    app.put("/allWithdraws/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid withdrawal ID" });
        }

        const withdraw = await withdrawCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!withdraw) {
          return res
            .status(404)
            .json({ message: "Withdrawal request not found" });
        }

        if (status === "approved") {
          const user = await usersCollection.findOne({
            email: withdraw.worker_email,
          });
          if (!user) {
            return res.status(404).json({ message: "User not found" });
          }

          await usersCollection.updateOne(
            { email: withdraw.worker_email },
            { $inc: { coins: -withdraw.withdrawal_coin } }
          );

          const paymentData = {
            type_of_payment: "get",
            worker_email: withdraw.worker_email,
            worker_name: withdraw.worker_name,
            withdrawal_coin: withdraw.withdrawal_coin,
            payment_amount: withdraw.withdrawal_amount,
            payment_system: withdraw.payment_system,
            account_number: withdraw.account_number,

            payment_date: new Date(),
          };

          await paymentsCollection.insertOne(paymentData);
        }

        await createNotification({
          message: `Your withdrawal request for ${withdraw.withdrawal_coin} coins has been approved`,
          toEmail: withdraw.worker_email,
          actionRoute: "/dashboard",
        });

        await withdrawCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        res.json({
          message: "Withdrawal approved and payment recorded successfully",
        });
      } catch (error) {
        // console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });
    // ....................................!................................................

    //...................................All Patch...........................................

    app.patch("/allUsers/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { role } = req.body;

        const result = await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: new Date().toISOString() } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "User not found" });
        }

        res.json({ success: true, message: "Last login updated" });
      } catch (error) {
        // console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch("/allUsers/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        const { role } = req.body;

        if (!role) return res.status(400).json({ message: "Role is required" });

        const result = await usersCollection.updateOne(
          { email },
          { $set: { role } }
        );

        if (result.matchedCount === 0)
          return res.status(404).json({ message: "User not found" });

        res.json({ success: true, message: "Role updated successfully" });
      } catch (error) {
        // console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch(
      "/submissions/reject/:id",
      verifyFBToken,
      verifyRoles(["buyer"]),
      async (req, res) => {
        const submissionId = req.params.id;

        const submission = await subCollection.findOne({
          _id: new ObjectId(submissionId),
        });
        try {
          if (!ObjectId.isValid(submissionId)) {
            return res.status(400).json({ message: "Invalid submission ID" });
          }

          const result = await subCollection.updateOne(
            { _id: new ObjectId(submissionId) },
            { $set: { status: "rejected" } }
          );
          await tasksCollection.updateOne(
            { _id: new ObjectId(submission.task_id) },
            { $inc: { currently_required_workers: 1 } }
          );
          if (result.modifiedCount === 0) {
            return res
              .status(404)
              .json({ message: "Submission not found or already rejected" });
          }

          await createNotification({
            message: `Your submission for ${submission.task_title} was rejected by ${submission.buyer_name}`,
            toEmail: submission.worker_email,
            actionRoute: "/dashboard/worker-home",
          });

          res.json({
            success: true,
            message: "Submission rejected successfully",
          });
        } catch (err) {
          // console.error("Error rejecting submission:", err);
          res.status(500).json({ message: "Failed to reject submission" });
        }
      }
    );
    // ...............................!.....................................................

    //...........................All get..............................................

    app.get(
      "/allUsers",
      verifyFBToken,
      verifyRoles(["admin"]),
      async (req, res) => {
        const users = await usersCollection.find().toArray();
        res.send(users);
      }
    );

    app.get("/best-workers", async (req, res) => {
      const bestWorkers = await workersCollection
        .find({ role: "worker" })
        .sort({ coins: -1 })
        .limit(6)
        .toArray();
      res.send(bestWorkers);
    });

    app.get("/allUsers/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ role: user.role });
    });

    app.get("/allUsers/:email", verifyFBToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).json(null);
      res.json(user);
    });

    app.get(
      "/allTasks",
      verifyFBToken,
      verifyRoles(["admin", "worker"]),
      async (req, res) => {
        const tasks = await tasksCollection.find().toArray();
        res.json(tasks);
      }
    );
    app.get(
      "/allTasks/:id",
      verifyFBToken,
      verifyRoles(["worker"]),
      async (req, res) => {
        const id = req.params.id;
        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        res.json(task);
      }
    );
    app.get(
      "/allTasks/buyer/:email",
      verifyFBToken,
      verifyRoles(["buyer"]),
      async (req, res) => {
        const buyerEmail = req.params.email;
        const tasks = await tasksCollection
          .find({ buyer_email: buyerEmail })
          .toArray();
        res.json(tasks);
      }
    );

    app.get(
      "/payments",
      verifyFBToken,
      verifyRoles(["admin"]),
      async (req, res) => {
        try {
          const payments = await paymentsCollection.find().toArray();
          res.status(200).json(payments);
        } catch (err) {
          // console.error("Failed to fetch payments:", err);
          res.status(500).json({ message: "Failed to fetch payments" });
        }
      }
    );

    app.get(
      "/payments/buyer/:email",
      verifyFBToken,
      verifyRoles(["buyer"]),
      async (req, res) => {
        try {
          const email = req.params.email;

          if (email !== req.decoded.email) {
            return res
              .status(403)
              .json({ message: "Forbidden: cannot access others' payments" });
          }

          const paymentsCollection = client
            .db("paymentsDb")
            .collection("payments");
          const payments = await paymentsCollection
            .find({ email })
            .sort({ date: -1 })
            .toArray();
          res.json(payments);
        } catch (error) {
          // console.error(error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.get(
      "/allSubmits/:taskId/:workerEmail",
      verifyFBToken,
      verifyRoles(["worker"]),
      async (req, res) => {
        try {
          const { taskId, workerEmail } = req.params;

          if (!workerEmail) {
            return res.status(400).json({ message: "Worker email required" });
          }

          const submission = await subCollection.findOne({
            task_id: taskId,
            worker_email: workerEmail,
          });

          res.json({ submitted: !!submission });
        } catch (error) {
          // console.error("Error fetching submission:", error);
          res.status(500).json({ success: false, message: error.message });
        }
      }
    );

    app.get(
      "/mySubmits/:workerEmail",
      verifyFBToken,
      verifyRoles(["worker"]),
      async (req, res) => {
        try {
          const workerEmail = req.params.workerEmail;

          const submissions = await subCollection
            .find({ worker_email: workerEmail })
            .sort({ current_date: -1 })
            .toArray();

          res.json(submissions);
        } catch (error) {
          // console.error("Error fetching submissions:", error);
          res.status(500).json({ success: false, message: error.message });
        }
      }
    );

    app.get(
      "/submissions/buyer/:buyerEmail",
      verifyFBToken,
      verifyRoles(["buyer"]),
      async (req, res) => {
        try {
          const buyerEmail = req.params.buyerEmail;

          if (buyerEmail !== req.decoded.email) {
            return res.status(403).json({
              message: "Forbidden: cannot access others' submissions",
            });
          }

          const subCollection = client
            .db("submissionDB")
            .collection("allSubmits");

          const submissions = await subCollection
            .find({ buyer_email: buyerEmail })
            .sort({ current_date: -1 })
            .toArray();

          res.json(submissions);
        } catch (error) {
          // console.error("Error fetching buyer submissions:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.get(
      "/allWithdraws",
      verifyFBToken,
      verifyRoles(["admin"]),
      async (req, res) => {
        const withDraws = await withdrawCollection.find().toArray();
        res.send(withDraws);
      }
    );

    app.get(
      "/allWithdraws/workers/:email",
      verifyFBToken,
      verifyRoles(["worker"]),
      async (req, res) => {
        try {
          const workerEmail = req.params.email;

          if (workerEmail !== req.decoded.email) {
            return res.status(403).json({
              message: "Forbidden: cannot access others' withdrawals",
            });
          }

          const withdrawCollection = client
            .db("withdrawDB")
            .collection("allWithdraws");

          const withdrawals = await withdrawCollection
            .find({ worker_email: workerEmail })
            .sort({ withdraw_date: -1 })
            .toArray();

          res.json(withdrawals);
        } catch (error) {
          // console.error("Error fetching withdrawals:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.get(
      "/submissions",
      verifyFBToken,
      verifyRoles(["admin"]),
      async (req, res) => {
        try {
          const submissions = await subCollection.find({}).toArray();
          res.status(200).json(submissions);
        } catch (err) {
          // console.error(err);
          res.status(500).json({ message: "Failed to fetch submissions" });
        }
      }
    );

    // .....................................!...............................................

    // ..................................All Delete.......................................

    app.delete(
      "/allTasks/:id",
      verifyFBToken,
      verifyRoles(["admin", "buyer"]),
      async (req, res) => {
        try {
          const id = req.params.id;

          const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
          if (!task) {
            return res.status(404).json({ message: "Task not found" });
          }

          const result = await tasksCollection.deleteOne({
            _id: new ObjectId(id),
          });
          if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Failed to delete task" });
          }

          const refundAmount =
            Number(task.payable_amount * task.currently_required_workers) || 0;
          const buyerEmail = task.buyer_email;

          const user = await usersCollection.findOne({ email: buyerEmail });
          if (!user) {
            return res
              .status(404)
              .json({ message: "User not found for refund" });
          }

          const updatedCoins = (user.coins || 0) + refundAmount;

          await usersCollection.updateOne(
            { email: buyerEmail },
            { $set: { coins: updatedCoins } }
          );

          await createNotification({
            message: `Your task "${task.task_title}" has been deleted. Refunded ${refundAmount} coins.`,
            toEmail: buyerEmail,
            actionRoute: "/dashboard/my-tasks",
          });

          res.json({
            message: "Task deleted successfully, coins refunded",
            refund: refundAmount,
            updatedCoins,
          });
        } catch (error) {
          // console.error("Error deleting task:", error);
          res.status(500).json({ message: "Failed to delete task" });
        }
      }
    );

    app.delete(
      "/allUsers/:id",
      verifyFBToken,
      verifyRoles(["admin"]),
      async (req, res) => {
        try {
          const userId = req.params.id;

          if (!ObjectId.isValid(userId)) {
            return res
              .status(400)
              .json({ success: false, message: "Invalid user ID" });
          }

          const result = await usersCollection.deleteOne({
            _id: new ObjectId(userId),
          });

          if (result.deletedCount === 0) {
            return res
              .status(404)
              .json({ success: false, message: "User not found" });
          }

          res.json({ success: true, message: "User deleted successfully" });
        } catch (error) {
          // console.error("Error deleting user:", error);
          res.status(500).json({ success: false, message: "Server error" });
        }
      }
    );
    // .........................................!............................................

    // ...................................notifications.....................................

    app.get("/notifications", verifyFBToken, async (req, res) => {
      const { toEmail } = req.query;
      const notifications = await notificationsCollection
        .find({ toEmail })
        .sort({ time: -1 })
        .toArray();
      res.json(notifications);
    });

    // Mark notification as read
    app.patch("/notifications/:id/read", async (req, res) => {
      await notificationsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { read: true } }
      );
      res.json({ success: true });
    });

    //..................................end..................................................

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Looking for money in server..!");
});

server.listen(port, () => {
  // console.log(`WorkNest server is running on port ${port} with Socket.IO`);
});
