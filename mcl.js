const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const axios = require("axios");
const mysql = require("mysql");
const cors = require("cors");
const dotenv = require("dotenv");
const config = require("./config/config");
dotenv.config();

const app = express();
const port = process.env.PORT || 443;
const certPath = path.join(__dirname, 'cert'); 
// const config = path.join(__dirname, 'config');

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true })); 
app.use(bodyParser.json());

// Database connection
const connection = mysql.createConnection(config.connection);

// Middleware to generate a token
const generateToken = async (req, res, next) => {
  const consumer_key = process.env.CONSUMER_KEY;
  const consumer_secret = process.env.CONSUMER_SECRET;
  const auth = Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");

  try {
    const response = await axios.get(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    req.token = response.data.access_token;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to generate token" });
  }
};

// Payment route
app.post("/api/stk", generateToken, async (req, res) => {
  const { amount, phone } = req.body;
  const phoneWithoutPlus = phone.substring(1);
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  const shortcode = process.env.SHORT_CODE;
  const passkey = process.env.PASS_KEY;
  const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

  try {
    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: `254${phoneWithoutPlus}`,
        PartyB: shortcode,
        PhoneNumber: `254${phoneWithoutPlus}`,
        CallBackURL: process.env.CALLBACK,
        AccountReference: "MCLINIC",
        TransactionDesc: "MCLinic",
      },
      {
        headers: {
          Authorization: `Bearer ${req.token}`,
        },
      }
    );

    return res.status(200).json(response.data);
  } catch (error) {
    console.error(error);
    return res.status(400).json(error.message);
  }
});

// Callback
app.post("/api/callback", (req, res) => {
 const data = req.body;
  console.log(data);

  // wrong pin error and wrong input
  if (data.Body.stkCallback.ResultCode === 2001) {
    console.log(data.Body.stkCallback.ResultDesc);
    const errorMessage = data.Body.stkCallback.ResultDesc;
    return res
      .status(400)
      .json({ message: errorMessage + " You entered the wrong pin" });
  }
  //   request cancelled by user
  if (data.Body.stkCallback.ResultCode === 1032) {
    console.log(data.Body.stkCallback.ResultDesc);
    const errorMessage = data.Body.stkCallback.ResultDesc;
    return res
      .status(400)
      .json({ message: errorMessage + " You cancelled the request" });
  }

  //
  if (!data.Body.stkCallback.CallbackMetadata) { 
    console.log(data.Body);
    // todo user has insufficeint balance
    const errorMessage = data.Body.stkCallback.ResultDesc;
    return res
      .status(400)
      .json({ message: errorMessage + " You Insurficient amount" });

  }
  //   successful payment
  console.log(data.Body.stkCallback.CallbackMetadata);
  const transactionData = data.Body.stkCallback.CallbackMetadata;
  const amount = transactionData.Item[0].Value;
  const receipt = transactionData.Item[1].Value;
  const date = transactionData.Item[3].Value;
  const phone_number = transactionData.Item[4].Value;
  console.log(receipt, amount, date, phone_number);
  connection.query(
    "INSERT INTO transactions (transaction_receipt, transaction_amount, transaction_date, transaction_phone_number) VALUES (?, ?, ?, ?)",
    [receipt, amount, date, phone_number],
    (err, result, fields) => {
      if (err) {
        console.warn(err);
        return res.json("Failed to write to db");
      }
      console.log(result);
    }
  );
});

// HTTPS options
const httpsOptions = {
  key: fs.readFileSync(path.join(certPath, "api_key.pem")),
  cert: fs.readFileSync(path.join(certPath, "fullchain.pem")),
};

// Create an HTTPS server
const server = https.createServer(httpsOptions, app);

// Database connection and server start
connection.connect((err) => {
  if (err) {
    console.error("Failed to connect to the database: " + err);
  } else {
    console.log("Database connected");

    server.listen(port, () => {
      console.log(`Server is listening on port ${port}`);
    });
  }
});
