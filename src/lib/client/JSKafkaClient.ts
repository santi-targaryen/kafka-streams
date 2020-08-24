import uuid from "uuid";
import { Kafka, PartitionDrainer, Drainer, Publisher } from "sinek";
import debugFactory from "debug";
const debug = debugFactory("kafka-streams:jsclient");
import { KafkaClient, KafkaClientStats, KafkaReadyCallback, KafkaErrorCallback } from "./KafkaClient";
import { EventEmitter } from "events";
import { KafkaStreamsConfig, CombinedKafkaConfig } from "../../interfaces";

const NOOP = () => { };

export class JSKafkaClient extends KafkaClient {
	public topic: string[] | string;
	public config: CombinedKafkaConfig;
	public kafkaConsumerClient: any = null;
	public kafkaProducerClient: Kafka = null;
	public consumer: any = null;
	public producer: Publisher = null;
	public produceTopic: string = null;
	public producePartitionCount = 1;
	
	private _produceHandler: any = null;

	/**
	 * KafkaClient (EventEmitter)
	 * that wraps an internal instance of a
	 * Sinek kafka- Consumer and/or Producer
	 * @param topic
	 * @param config
	 */
	constructor(topic: string, config: CombinedKafkaConfig) {
	  super();

	  this.topic = topic;
	  this.config = config;
	}

	/**
	 * sets a handler for produce messages
	 * (emits whenever kafka messages are produced/delivered)
	 * @param handler {EventEmitter}
	 */
	setProduceHandler(handler: EventEmitter): void {
	  this._produceHandler = handler;
	}

	/**
	 * returns the produce handler instance if present
	 * @returns {null|EventEmitter}
	 */
	getProduceHandler(): null | EventEmitter {
	  return this._produceHandler;
	}

	/**
	 * overwrites the topic
	 * @param topics {Array<string>}
	 */
	overwriteTopics(topics: string[]): void {
	  this.topic = topics;
	}

	/**
	 * starts a new kafka consumer (using sinek's partition drainer)
	 * will await a kafka-producer-ready-event if started withProducer=true
	 * @param readyCallback
	 * @param kafkaErrorCallback
	 * @param withProducer
	 * @param withBackPressure
	 */
	start(
	  readyCallback: KafkaReadyCallback = null,
	  kafkaErrorCallback: KafkaErrorCallback = null,
	  withProducer = false,
	  withBackPressure = false
	): void {

	  //might be possible if the parent stream is build to produce messages only
	  if (!this.topic || !this.topic.length) {
	    return;
	  }

	  const { zkConStr, kafkaHost, logger, groupId, workerPerPartition, options } = this.config;

	  let conStr = null;

	  if (typeof kafkaHost === "string") {
	    conStr = kafkaHost;
	  }

	  if (typeof zkConStr === "string") {
	    conStr = zkConStr;
	  }

	  if (conStr === null) {
	    throw new Error("One of the following: zkConStr or kafkaHost must be defined.");
	  }

	  this.kafkaConsumerClient = new Kafka(conStr, logger, conStr === kafkaHost);

	  this.kafkaConsumerClient.on("ready", () => {
	    debug("consumer ready");

	    if (readyCallback) {
	      readyCallback();
	    }
	  });
	  this.kafkaConsumerClient.on("error", kafkaErrorCallback || NOOP);

	  this.kafkaConsumerClient.becomeConsumer(this.topic, groupId, options || {});

	  if (withBackPressure) {
	    this.consumer = new PartitionDrainer(this.kafkaConsumerClient, workerPerPartition || 1, false, false);
	  } else {
	    this.consumer = new Drainer(this.kafkaConsumerClient, workerPerPartition, true, false, false);
	  }

	  //consumer has to wait for producer
	  super.once("kafka-producer-ready", () => {

	    if (withBackPressure) {

	      if (this.topic.length > 1) {
	        throw new Error("JS Client does not support multiple topics in backpressure mode.");
	      }

	      this.consumer.drain(this.topic[0], (message, done) => {
	        super.emit("message", message);
	        done();
	      }).catch(e => kafkaErrorCallback(e));
	    } else {
	      this.consumer.drain((message, done) => {
	        super.emit("message", message);
	        done();
	      });
	    }
	  });

	  if (!withProducer) {
	    super.emit("kafka-producer-ready", true);
	  }
	}

	/**
	 * starts a new kafka-producer using sinek's publisher
	 * will fire kafka-producer-ready-event
	 * requires a topic's partition count during initialisation
	 * @param {string} produceTopic
	 * 	 The topic to produce too.
	 * @param {number} partitions
	 * 	 The partitions for the topic.
	 * @param {callback|null} readyCallback
	 * @param {callback|null} kafkaErrorCallback
	 * @param {KafkaStreamsConfig} outputKafkaConfig
	 */
	setupProducer(
	  produceTopic: string,
	  partitions = 1,
	  readyCallback: KafkaReadyCallback = null,
	  kafkaErrorCallback: KafkaErrorCallback = null,
	  outputKafkaConfig: KafkaStreamsConfig
	): void {

	  this.produceTopic = produceTopic || this.produceTopic;
	  this.producePartitionCount = partitions;
	  const { zkConStr, kafkaHost, logger, clientName, options } = (outputKafkaConfig || this.config);

	  let conStr = null;

	  if (typeof kafkaHost === "string") {
	    conStr = kafkaHost;
	  }

	  if (typeof zkConStr === "string") {
	    conStr = zkConStr;
	  }

	  if (conStr === null) {
	    throw new Error("One of the following: zkConStr or kafkaHost must be defined.");
	  }

	  //might be possible if the parent stream is build to produce messages only
	  if (!this.kafkaProducerClient) {
	    this.kafkaProducerClient = new Kafka(conStr, logger, conStr === kafkaHost);

	    //consumer is awaiting producer
	    this.kafkaProducerClient.on("ready", () => {
	      debug("producer ready");
	      super.emit("kafka-producer-ready", true);
	      if (readyCallback) {
	        readyCallback();
	      }
	    });

	    this.kafkaProducerClient.on("error", kafkaErrorCallback || NOOP);
	  }

	  this.kafkaProducerClient.becomeProducer([this.produceTopic], clientName, options);
	  this.producer = new Publisher(this.kafkaProducerClient, partitions || 1, 0, 100);
	}

	/**
	 * simply produces a message or multiple on a topic
	 * if producerPartitionCount is > 1 it will randomize
	 * the target partition for the message/s
	 * @param topic
	 * @param message
	 * @returns {*}
	 */
	send(topic: string, message: any[]): Promise<void> {

	  if (!this.producer) {
	    return Promise.reject("producer is not yet setup.");
	  }

	  let partition = -1;
	  if (this.producePartitionCount < 2) {
	    partition = 0;
	  } else {
	    partition = KafkaClient._getRandomIntInclusive(0, this.producePartitionCount);
	  }

	  return this.producer.send(topic,
	    Array.isArray(message) ? message : [message],
	    null,
	    partition,
	    0
	  );
	}

	/**
	 * buffers a keyed message to be send
	 * a keyed message needs an identifier, if none is provided
	 * an uuid.v4() will be generated
	 * @param topic
	 * @param identifier
	 * @param payload
	 * @param compressionType
	 * @returns {*}
	 */
	buffer(
	  topic: string,
	  identifier: string,
	  payload: Buffer | string,
	  compressionType = 0
	): Promise<void> {

	  if (!this.producer) {
	    return Promise.reject("producer is not yet setup.");
	  }

	  if (!identifier) {
	    identifier = uuid.v4();
	  }

	  return this.producer.appendBuffer(topic, identifier, payload, compressionType);
	}

	/**
	 * buffers a keyed message in (a base json format) to be send
	 * a keyed message needs an identifier, if none is provided
	 * an uuid.4() will be generated
	 * @param topic
	 * @param identifier
	 * @param payload
	 * @param version
	 * @param compressionType
	 * @returns {*}
	 */
	bufferFormat(
	  topic: string,
	  identifier: string,
	  payload: Buffer | string,
	  version = 1,
	  compressionType = 0
	): Promise<void> {

	  if (!this.producer) {
	    return Promise.reject("producer is not yet setup.");
	  }

	  if (!identifier) {
	    identifier = uuid.v4();
	  }

	  return this.producer.bufferPublishMessage(topic, identifier, payload, version, compressionType);
	}

	/**
	 * Pauses the client.
	 */
	pause(): void {

	  if (this.consumer) {
	    this.consumer.pause();
	  }

	  if (this.producer) {
	    this.producer.pause();
	  }
	}
	/**
	 * Resumes the client.
	 */
	resume(): void {

	  if (this.consumer) {
	    this.consumer.resume();
	  }

	  if (this.producer) {
	    this.producer.resume();
	  }
	}

	/**
	 * Gets stats for the client.
	 */
	getStats(): KafkaClientStats {
	  return {
	    inTopic: this.topic ? this.topic : null,
	    consumer: this.consumer ? this.consumer.getStats() : null,

	    outTopic: this.produceTopic ? this.produceTopic : null,
	    producer: this.producer ? this.producer.getStats() : null
	  };
	}

	/**
	 * Close the client.
	 * 
	 * @param {boolean} commit 
	 */
	close(commit = false): void {

	  if (this.consumer) {
	    this.consumer.close(commit);
	    this.consumer = null;
	  }

	  if (this.producer) {
	    this.producer.close();
	    this.producer = null;
	  }
	}

	/**
	 * Closes the consumer.
	 */
	closeConsumer(): void {
	  //required by KTable
	  if (this.consumer) {
	    this.consumer.close();
	    this.consumer = null;
	  }
	}
}