
const cds = require("@sap/cds");

const { SELECT, INSERT, UPDATE } = cds.ql;

module.exports = cds.service.impl(async function() {

    const {
        StockBalances,
        StockMovements,
        Reservations,
        TransferRequests,
        TransferItems,
        Alerts,ReorderLevels
    } = this.entities

    

    // COMMON HELPER FUNCTIONS
    
 const fail = (req, status, message) =>
        req.reject(status, message);

   const number = (value) => Number(value || 0);

    
   
    // Validate positive quantity

    const requirePositive = (req, value, fieldName) => {

        if (
            value === null ||
            value === undefined ||
            value === "" ||
            !Number.isFinite(Number(value)) ||
            Number(value) <= 0
        ) {
            fail(req, 400, `${fieldName} must be greater than zero.`);
        }

    };



    

    // Get stock balance

    const getStock = async (tx, key, req) => {

        const stock = await tx.run(
            SELECT.one.from(StockBalances)
                .where(key)
                .forUpdate()
        );

        if (!stock) {
            fail(req, 404, "Stock balance was not found.");
        }

        return stock;

    };


    // Validate stock balance quantities

    const validateStock = (req, stock) => {

        const unrestricted = number(stock.unrestricted);
        const reserved = number(stock.reserved);
        const blocked = number(stock.blocked);

        if (
            unrestricted < 0 ||
            reserved < 0 ||
            blocked < 0
        ) {
            fail(req, 409, "Stock quantities cannot be negative.");
        }

        if (reserved > unrestricted) {
            fail(
                req,
                409,
                "Reserved quantity cannot exceed unrestricted stock."
            );
        }

    };


    // Update stock balance

    const updateStock = async (tx, stock, changes, req) => {

        const result = await tx.run(
            UPDATE(StockBalances)
                .set({
                    ...changes,
                    version: number(stock.version) + 1
                })
                .where({
                    material_ID: stock.material_ID,
                    plant_code: stock.plant_code,
                    location_ID: stock.location_ID,
                    batch: stock.batch,
                    version: number(stock.version)
                })
        );

        if (result === 0) {
            fail(
                req,
                409,
                "Stock was changed by another user. Refresh and try again."
            );
        }

    };


    // STOCK RESERVATION
   

    this.on("reserve", "StockBalances", async (req) => {

        const {
            quantity,
            note,
            idempotencykey
        } = req.data;

        // Validate reservation quantity

        requirePositive(req, quantity, "Reservation quantity");


        //  Validate idempotency key

        if (
            !idempotencykey ||
            !String(idempotencykey).trim()
        ) {
            fail(req, 400, "Idempotency key is required.");
        }


        //  Start request transaction

        const tx = cds.tx(req);


        //  Check duplicate reservation request

        const existing = await tx.run(
            SELECT.one.from(Reservations).where({
                idempotencykey
            })
        );

        if (existing) {

            // Same key cannot be reused for a different request

            if (
                number(existing.quantity) !== number(quantity)
            ) {
                fail(
                    req,
                    409,
                    "Idempotency key was already used with a different quantity."
                );
            }

            return existing;
        }


        //  Get stock balance key from request

        const keyParams = req.params?.[0] || undefined;

        const key = {
            material_ID: keyParams.material_ID,
            plant_code: keyParams.plant_code,
            location_ID: keyParams.location_ID,
            batch: keyParams.batch
        };


        //  Validate stock balance key

        if (
            !key.material_ID ||
            !key.plant_code ||
            !key.location_ID
        ) {
            fail(
                req,
                400,
                "Material, plant and storage location are required."
            );
        }


        //  Get and lock stock balance

        const stock = await getStock(tx, key, req);


        //  Check user plant authorization

    


        //  Validate existing stock quantities

        validateStock(req, stock);
            
        //  Check available stock
        const available = number(stock.unrestricted) - number(stock.reserved);

        if (number(quantity) > available) {

            fail(
                req,
                400,
                `Insufficient stock. Available quantity: ${available}.`
            );

        }


        //  Create reservation

        const reservationID = cds.utils.uuid();

        await tx.run(
            INSERT.into(Reservations).entries({

                ID: reservationID,

                material_ID: stock.material_ID,
                plant_code: stock.plant_code,
                location_ID: stock.location_ID,
                batch: stock.batch,

                quantity: number(quantity),
                consumedQty: 0,
                releasedQty: 0,

                status: "Active",

                note: note || "",
                idempotencykey: idempotencykey

            })
        );


        //  Increase reserved stock quantity

        await updateStock(
            tx,
            stock,
            {
                reserved:
                    number(stock.reserved) + number(quantity)
            },
            req
        );


        //  Return created reservation

        return tx.run(
            SELECT.one.from(Reservations).where({
                ID: reservationID
            })
        );

    });


    // RELEASE RESERVATION
 

    this.on("releaseReservation", "Reservations", async (req) => {

        const reservationID = req.params?.[0]?.ID;

        //  Validate reservation ID

        if (!reservationID) {
            fail(req, 400, "Reservation ID is required.");
        }


        const tx = cds.tx(req);


        //  Get reservation and lock it

        const reservation = await tx.run(
            SELECT.one.from(Reservations)
                .where({ ID: reservationID })
                .forUpdate()
        );


        //  Check reservation exists

        if (!reservation) {
            fail(req, 404, "Reservation was not found.");
        }


        //  Only active reservations can be released

        if (reservation.status !== "Active") {

            fail(
                req,
                400,
                "Only active reservations can be released."
            );

        }



       


        //  Calculate remaining reservation quantity

        const remaining =
            number(reservation.quantity) -
            number(reservation.consumedQty) -
            number(reservation.releasedQty);


        //  Validate reservation quantities

        if (remaining < 0) {

            fail(
                req,
                409,
                "Consumed and released quantities cannot exceed reserved quantity."
            );

        }


        //  Get related stock balance

        const key = {

            material_ID: reservation.material_ID,
            plant_code: reservation.plant_code,
            location_ID: reservation.location_ID,
            batch: reservation.batch

        };

        const stock = await getStock(tx, key, req);


        //  Validate stock balance

        validateStock(req, stock);


        //  Check reserved stock before release

        if (number(stock.reserved) < remaining) {

            fail(
                req,
                409,
                "Stock reserved quantity is less than the reservation quantity."
            );

        }


        //  Reduce reserved stock quantity

        await updateStock(
            tx,
            stock,
            {
                reserved:
                    number(stock.reserved) - remaining
            },
            req
        );


        //  Update reservation status

        await tx.run(
            UPDATE(Reservations)
                .set({

                    releasedQty:
                        number(reservation.releasedQty) + remaining,

                    status: "Released"

                })
                .where({
                    ID: reservationID
                })
        );


        //  Return updated reservation

        return tx.run(
            SELECT.one.from(Reservations).where({
                ID: reservationID
            })
        );

    });
    

// second port of brd execution process
// stock movement

// transfer request validation

this.before("CREATE", "TransferRequests", async (req) => {
      const data = req.data;

      if (!data.fromPlant_code || !data.toPlant_code) {
        fail(
          req,
          400,
          "Source plant and destination plant are required."
        );
      }

      if (!data.fromLocation_ID || !data.toLocation_ID) {
        fail(
          req,
          400,
          "Source and destination storage locations are required."
        );
      }

      if (
        data.fromPlant_code === data.toPlant_code &&
        data.fromLocation_ID === data.toLocation_ID
      ) {
        fail(
          req,
          400,
          "Source and destination locations must be different."
        );
      }

      assertPlantAccess(req, data.fromPlant_code);

      if (!Array.isArray(data.items) || data.items.length === 0) {
        fail(
          req,
          400,
          "At least one transfer item is required."
        );
      }

      for (const item of data.items) {
        requirePositive(
          req,
          item.requestedQty,
          "Requested quantity"
        );

        if (!item.material_ID) {
          fail(
            req,
            400,
            "Material is required for every transfer item."
          );
        }
      }

      if (!data.number) {
        data.number = `TR-${Date.now()}`;
      }

      data.status = "Requested";
    });


// cancel trannsfer and release reservations
    this.on("cancelTransfer", "TransferRequests", async (req) => {
      const transferID = req.params?.[0]?.ID;

      const tx = cds.tx(req);

      const transfer = await getTransfer(
        tx,
        transferID,
        req
      );

      assertPlantAccess(req, transfer.fromPlant_code);

      if (
        ["Completed", "Cancelled"].includes(transfer.status)
      ) {
        fail(
          req,
          400,
          "Completed or cancelled transfers cannot be cancelled."
        );
      }

      const items = await getTransferItems(tx, transferID);

      for (const item of items) {
        const reservations = await getReservationForItem(
          tx,
          item.ID
        );

        for (const reservation of reservations) {
          const remaining =
            number(reservation.quantity) -
            number(reservation.consumedQty) -
            number(reservation.releasedQty);

          if (remaining <= 0) continue;

          const stock = await getStock(
            tx,
            {
              material_ID: reservation.material_ID,
              plant_code: reservation.plant_code,
              location_ID: reservation.location_ID,
              batch: cleanBatch(reservation.batch)
            },
            req
          );

          await updateStock(
            tx,
            stock,
            {
              reserved: Math.max(
                0,
                number(stock.reserved) - remaining
              )
            },
            req
          );

          await tx.run(
            UPDATE(Reservations)
              .set({
                releasedQty:
                  number(reservation.releasedQty) + remaining,
                status: "Released"
              })
              .where({ ID: reservation.ID })
          );
        }

        const remainingToDispatch =
          number(item.requestedQty) -
          number(item.dispatchedQty) -
          number(item.cancelledQty);

        if (remainingToDispatch > 0) {
          await tx.run(
            UPDATE(TransferItems)
              .set({
                cancelledQty:
                  number(item.cancelledQty) +
                  remainingToDispatch
              })
              .where({ ID: item.ID })
          );
        }
      }

      await setTransferStatus(
        tx,
        transferID,
        "Cancelled"
      );

      return tx.run(
        SELECT.one.from(TransferRequests).where({
          ID: transferID
        })
      );
    });
})
