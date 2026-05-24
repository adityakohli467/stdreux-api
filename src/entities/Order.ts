import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from "typeorm"
import { Customer } from "./Customer"
import { Location } from "./Location"
import { OrderProduct } from "./OrderProduct"
import { PaymentHistory } from "./PaymentHistory"

@Entity("orders")
@Index(["customer_id"])
@Index(["order_status"])
@Index(["payment_transaction_id"])
@Index(["payment_status"])
export class Order {
  @PrimaryGeneratedColumn()
  order_id!: number

  @Column({ type: "int", nullable: true })
  customer_id!: number

  @Column({ type: "int", nullable: true })
  user_id!: number

  @Column({ type: "int", nullable: true })
  location_id!: number

  @Column({ type: "int", default: 1 })
  branch_id!: number

  @Column({ type: "varchar", length: 255, nullable: true })
  firstname!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  lastname!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  email!: string

  @Column({ type: "varchar", length: 50, nullable: true })
  telephone!: string

  @Column({ type: "text", nullable: true })
  shipping_address_1!: string

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  order_total!: number

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  delivery_fee!: number

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  coupon_discount!: number

  @Column({ type: "int", default: 1 })
  order_status!: number

  @Column({ type: "timestamp", nullable: true })
  delivery_date_time!: Date

  @Column({ type: "varchar", length: 50, nullable: true })
  payment_method!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  payment_transaction_id!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  payment_token!: string

  @Column({ type: "varchar", length: 50, default: "pending" })
  payment_status!: string

  @Column({ type: "varchar", length: 50, default: "stripe" })
  payment_gateway!: string

  @Column({ type: "jsonb", nullable: true })
  payment_response!: any

  @Column({ type: "timestamp", nullable: true })
  payment_date!: Date

  @Column({ type: "varchar", length: 255, nullable: true })
  invoice_url!: string

  @Column({ type: "int", default: 0 })
  standing_order!: number

  @Column({ type: "text", nullable: true })
  order_comments!: string

  @Column({ type: "int", nullable: true })
  coupon_id!: number

  @Column({ type: "int", nullable: true })
  is_completed!: number

  @Column({ type: "varchar", length: 50, nullable: true })
  customer_from!: string

  @Column({ type: "text", nullable: true })
  delivery_address!: string

  @Column({ type: "varchar", length: 50, nullable: true })
  delivery_method!: string

  @Column({ type: "text", nullable: true })
  delivery_contact!: string

  @Column({ type: "text", nullable: true })
  delivery_details!: string

  @Column({ type: "varchar", length: 255, nullable: true })
  account_email!: string

  @Column({ type: "varchar", length: 100, nullable: true })
  cost_center!: string

  @Column({ type: "int", nullable: true })
  shipping_method!: number

  @Column({ type: "varchar", length: 255, nullable: true })
  customer_order_name!: string

  @Column({ type: "int", default: 0 })
  packaging_status!: number // 0 = New Order, 1 = Printed, 2 = Packed, 3 = Delivered

  @CreateDateColumn({ name: "date_added" })
  date_added!: Date

  @UpdateDateColumn({ name: "date_modified" })
  date_modified!: Date

  // Relations
  @ManyToOne(() => Customer, (customer) => customer.orders)
  @JoinColumn({ name: "customer_id" })
  customer!: Customer

  @ManyToOne(() => Location)
  @JoinColumn({ name: "location_id" })
  location!: Location

  @OneToMany(() => OrderProduct, (orderProduct) => orderProduct.order)
  order_products!: OrderProduct[]

  @OneToMany(() => PaymentHistory, (paymentHistory) => paymentHistory.order)
  payment_history!: PaymentHistory[]
}

